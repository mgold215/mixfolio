import Foundation

// MARK: - MixbaseAPI
// Client for the web app's authenticated API routes (mixbase.app). These are
// the routes that run the paid AI generation server-side — artwork via
// Replicate, visualizers via Runway — with per-tier limits enforced where the
// keys live. The middleware accepts `Authorization: Bearer <supabase access
// token>`, which is exactly how this client authenticates.

final class MixbaseAPI {

    static let shared = MixbaseAPI()

    private let baseURL = Config.apiBaseURL

    // Generation routes block while the server polls the AI provider — artwork
    // up to 2 min, Runway video up to 5 min — so the session must allow far
    // more than URLSession's default 60s per-request timeout.
    private let session: URLSession

    private let decoder: JSONDecoder

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 6 * 60
        config.timeoutIntervalForResource = 8 * 60
        self.session = URLSession(configuration: config)

        // Same tolerant date handling as SupabaseService: ISO 8601 with and
        // without fractional seconds (Next.js/PostgREST emit both).
        let isoFractional = ISO8601DateFormatter()
        isoFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoPlain = ISO8601DateFormatter()
        isoPlain.formatOptions = [.withInternetDateTime]

        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)
            if let date = isoFractional.date(from: dateString) { return date }
            if let date = isoPlain.date(from: dateString) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(dateString)"
            )
        }
    }

    // MARK: - Image models
    // Mirrors IMAGE_MODELS in src/lib/artwork-models.ts — ids must match the
    // server registry. First entry is the default.
    struct ImageModel: Identifiable {
        let id: String
        let label: String
    }

    static let imageModels: [ImageModel] = [
        ImageModel(id: "flux-ultra", label: "FLUX Ultra Raw"),
        ImageModel(id: "nano-pro",   label: "Nano Banana Pro"),
        ImageModel(id: "flux-krea",  label: "FLUX Krea"),
        ImageModel(id: "seedream",   label: "Seedream 4"),
        ImageModel(id: "flux",       label: "Flux 2 Pro"),
        ImageModel(id: "nano",       label: "Nano Banana 2"),
    ]

    // MARK: - Artwork

    /// Generate AI artwork for a project. The server generates the image,
    /// uploads it to storage AND applies it as the project's artwork.
    /// Returns the public URL of the applied artwork.
    func generateArtwork(projectId: UUID, prompt: String, model: String, vary: Bool) async throws -> String {
        let body: [String: Any] = [
            "project_id": projectId.uuidString.lowercased(),
            "prompt": prompt,
            "model": model,
            "vary": vary,
        ]
        let json = try await requestJSON(path: "/api/generate-artwork", method: "POST", body: body)
        guard let url = json["artwork_url"] as? String else {
            throw MixbaseAPIError.invalidResponse("No artwork URL in response")
        }
        return url
    }

    // MARK: - Visualizers
    // Deliberately view/pin/delete only. Visualizer GENERATION is a web-only
    // feature: it is gated to paid accounts server-side, and App Store
    // Guideline 3.1.1 forbids the app exposing functionality that is
    // purchased outside Apple's In-App Purchase. Do not add generation here
    // without shipping StoreKit IAP alongside it.

    /// Server-rendered free visualizer (ffmpeg on the backend — no AI credits).
    /// The render takes seconds for the 6s formats, up to ~1 min for YouTube.
    /// Returns the stored mf-video URL (always persisted to the Media library).
    func generateFreeVisualizer(
        projectId: UUID,
        imageUrl: String,
        format: String,
        effect: String,
        bpm: Int?
    ) async throws -> String {
        var body: [String: Any] = [
            "projectId": projectId.uuidString.lowercased(),
            "imageUrl": imageUrl,
            "format": format,
            "effect": effect,
        ]
        if let bpm { body["bpm"] = bpm }
        let json = try await requestJSON(path: "/api/visualizer/free", method: "POST", body: body)
        guard let url = json["video_url"] as? String else {
            throw MixbaseAPIError.invalidResponse("No video URL in response")
        }
        return url
    }

    /// Every saved visualizer the user owns, newest first.
    func fetchVisualizers() async throws -> [Visualizer] {
        let data = try await requestData(path: "/api/visualizer", method: "GET")
        return try decoder.decode([Visualizer].self, from: data)
    }

    /// Delete a saved visualizer (also un-pins it from any project server-side).
    func deleteVisualizer(id: UUID) async throws {
        _ = try await requestData(path: "/api/visualizer/\(id.uuidString.lowercased())", method: "DELETE")
    }

    /// Pin (or clear, with nil) a video as a project's visualizer. The server
    /// verifies the URL is a visualizer the user actually owns.
    func pinVisualizer(projectId: UUID, videoUrl: String?) async throws {
        let body: [String: Any] = ["visualizer_url": videoUrl ?? NSNull()]
        _ = try await requestJSON(path: "/api/projects/\(projectId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    // MARK: - Instrumental slot

    /// Set (or clear, with nil) the project's pinned instrumental — the one
    /// no-vocals file that lives beside the mixes. Goes through the web route
    /// rather than PostgREST so the server validates the URL is a Supabase
    /// Storage URL and self-heals the 035 column if a deploy beat the
    /// migration to production.
    func setInstrumental(projectId: UUID, url: String?) async throws {
        let body: [String: Any] = ["instrumental_url": url ?? NSNull()]
        _ = try await requestJSON(path: "/api/projects/\(projectId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    /// Set whether someone holding this version's share link is offered a
    /// download button.
    ///
    /// This is a CONSENT SIGNAL, not an access control — see
    /// src/lib/version-defaults.ts. /api/audio is a public path and mf-audio is
    /// public-read, so anyone with the share link can already fetch the bytes.
    /// The flag says what the artist is comfortable with; do not build anything
    /// here that implies it withholds the file.
    ///
    /// Goes through the web route rather than PostgREST so it picks up the
    /// route's ownership check and rate limit.
    func setAllowDownload(versionId: UUID, allow: Bool) async throws {
        let body: [String: Any] = ["allow_download": allow]
        _ = try await requestJSON(path: "/api/versions/\(versionId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    // MARK: - Artwork assignment (Media library)

    /// Set an existing artwork image as a project's cover (must be a Supabase
    /// storage URL — the server validates and clears any stale finalized render).
    func assignArtworkToProject(projectId: UUID, artworkUrl: String) async throws {
        let body: [String: Any] = ["artwork_url": artworkUrl]
        _ = try await requestJSON(path: "/api/projects/\(projectId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    /// Set an artwork image as a collection's cover.
    func setCollectionCover(collectionId: UUID, coverUrl: String) async throws {
        let body: [String: Any] = ["cover_url": coverUrl]
        _ = try await requestJSON(path: "/api/collections/\(collectionId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    // MARK: - Released Library (mb_library_tracks via /api/library)

    /// Everything the artist has put out — ISRCs, UPCs, dates, project links.
    func fetchLibraryTracks() async throws -> [LibraryTrack] {
        let data = try await requestData(path: "/api/library", method: "GET")
        return try decoder.decode([LibraryTrack].self, from: data)
    }

    /// Sync the discography from Spotify/Deezer (server-side, upsert).
    /// Returns a human-readable summary of what changed.
    func syncLibrary(artist: String) async throws -> String {
        let json = try await requestJSON(path: "/api/library", method: "POST", body: ["artist": artist])
        let total = json["total"] as? Int ?? 0
        let created = json["created"] as? Int ?? 0
        let updated = json["updated"] as? Int ?? 0
        let name = json["artistName"] as? String ?? artist
        let source = (json["source"] as? String) == "spotify" ? "Spotify" : "Deezer"
        return "Synced \(total) track\(total == 1 ? "" : "s") for \(name) via \(source) — \(created) new, \(updated) updated."
    }

    enum IsrcLookup {
        case found(LibraryTrack)
        case notFound(String)
    }

    /// Targeted MusicBrainz lookup for one track's missing ISRC.
    func findIsrc(trackId: UUID) async throws -> IsrcLookup {
        let data = try await requestData(
            path: "/api/library/find-isrc",
            method: "POST",
            body: ["track_id": trackId.uuidString.lowercased()]
        )
        if let track = try? decoder.decode(LibraryTrack.self, from: data) {
            return .found(track)
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return .notFound(json?["message"] as? String ?? "No ISRC found for this track.")
    }

    /// Link (or unlink, with nil) the project holding a track's original file.
    /// Returns the updated row.
    func linkLibraryTrack(id: UUID, projectId: UUID?) async throws -> LibraryTrack {
        let body: [String: Any] = ["project_id": projectId?.uuidString.lowercased() ?? NSNull()]
        let data = try await requestData(path: "/api/library/\(id.uuidString.lowercased())", method: "PATCH", body: body)
        return try decoder.decode(LibraryTrack.self, from: data)
    }

    /// Remove a track from the released library.
    func deleteLibraryTrack(id: UUID) async throws {
        _ = try await requestData(path: "/api/library/\(id.uuidString.lowercased())", method: "DELETE")
    }

    // MARK: - Community Feed (cross-user by design)

    /// Recent uploads across ALL artists — one entry per project (newest mix),
    /// with inter-artist comments and that project's older mixes.
    // MARK: - Account

    /// Permanently delete the signed-in account and all its data (Guideline
    /// 5.1.1(v)). Goes through requestData so an expired access token is
    /// refreshed and retried instead of failing the one flow Apple requires
    /// to always work.
    func deleteAccount() async throws {
        _ = try await requestData(path: "/api/auth/delete-account", method: "POST")
    }

    // MARK: - Moderation (App Store Guideline 1.2)

    /// Report objectionable feed content. type is "version" (a track entry)
    /// or "comment". The reporter stops seeing the content immediately;
    /// heavily-reported content is removed for everyone.
    func reportContent(type: String, id: UUID, reason: String? = nil) async throws {
        var body: [String: Any] = [
            "content_type": type,
            "content_id": id.uuidString.lowercased(),
        ]
        if let reason, !reason.isEmpty { body["reason"] = reason }
        _ = try await requestData(path: "/api/feed/report", method: "POST", body: body)
    }

    /// Block another artist — their uploads and comments disappear from this
    /// account's feed everywhere, immediately and on every future load.
    func blockUser(id: UUID) async throws {
        _ = try await requestData(path: "/api/feed/block", method: "POST", body: [
            "user_id": id.uuidString.lowercased(),
        ])
    }

    /// Wrapper that swallows a single undecodable feed row. Decoding the feed
    /// as a plain [FeedItem] means ONE malformed entry (e.g. a legacy ownerless
    /// upload whose user_id serializes as "") blanks the entire community feed.
    private struct LossyFeedItem: Decodable {
        let item: FeedItem?
        init(from decoder: Decoder) {
            item = try? FeedItem(from: decoder)
        }
    }

    func fetchFeed() async throws -> [FeedItem] {
        let data = try await requestData(path: "/api/feed", method: "GET")
        return try decoder.decode([LossyFeedItem].self, from: data).compactMap(\.item)
    }

    /// Leave a comment on another artist's upload. Returns the saved comment
    /// (with this user's public artist name filled in server-side).
    func postFeedComment(versionId: UUID, comment: String) async throws -> FeedComment {
        let body: [String: Any] = [
            "version_id": versionId.uuidString.lowercased(),
            "comment": comment,
        ]
        let data = try await requestData(path: "/api/feed/comments", method: "POST", body: body)
        return try decoder.decode(FeedComment.self, from: data)
    }

    // MARK: - Mix notes (quick notes on your own mix)

    /// Jot a timestamped note on one of your own mixes — the same owner-only
    /// route the web player's notes menu posts through. The server verifies
    /// ownership, stamps the fixed "My notes" byline and writes no activity
    /// row (your own note must not ring your own notification bell), so both
    /// platforms produce identical mb_feedback rows and the web project
    /// page's markers, punch list and AI summary pick them up unchanged.
    /// Returns 201 with the inserted row in PostgREST column shape, so
    /// Feedback decodes the same way it does from a direct fetch.
    func postMixNote(versionId: UUID, comment: String, timestampSeconds: Int) async throws -> Feedback {
        let body: [String: Any] = [
            "version_id": versionId.uuidString.lowercased(),
            "comment": comment,
            "timestamp_seconds": timestampSeconds,
        ]
        let data = try await requestData(path: "/api/mix-notes", method: "POST", body: body)
        return try decoder.decode(Feedback.self, from: data)
    }

    // MARK: - Core request plumbing

    /// Perform a request and parse the response as a JSON object.
    // MARK: - Collections

    /// Mint (or fetch — it's idempotent) the public album share link for a
    /// collection. The server returns the canonical mixbase.app URL.
    func collectionShareLink(collectionId: UUID) async throws -> URL {
        let json = try await requestJSON(
            path: "/api/collections/\(collectionId.uuidString.lowercased())/share",
            method: "POST"
        )
        guard let urlString = json["url"] as? String, let url = URL(string: urlString) else {
            throw MixbaseAPIError.invalidResponse("No share URL in response")
        }
        return url
    }

    // MARK: - Versions (new mixes)

    /// Create the mb_versions row for a mix that has just finished uploading.
    ///
    /// Goes through the web route rather than writing to PostgREST directly,
    /// because three of this row's columns are the SERVER's decision, not the
    /// client's — and a direct insert has to invent all three:
    ///
    ///  • `allow_download` — a CONSENT signal, not an access control (see the
    ///    long note in src/lib/version-defaults.ts). It is deliberately NOT in
    ///    the body below, and must not be added: the route only INHERITS the
    ///    artist's previous choice when the field is ABSENT, and treats any
    ///    real boolean — `false` included — as an explicit decision that wins.
    ///    Sending a hardcoded `false` "to be safe" is exactly the bug this
    ///    replaced: an artist who ticked "let people with the share link
    ///    download this" on the web had it silently switched back off by their
    ///    next upload from the phone, with nothing in the UI to say so.
    ///  • `status` and `label` — parsed from the filename server-side
    ///    ("MASTER 2.wav" → Master, labelled 2), so both platforms land on the
    ///    same four statuses and the same per-kind numbering.
    ///  • `version_number` — computed server-side as max+1 and retried on the
    ///    unique-index violation, so two uploads racing the same project can't
    ///    both become "v2".
    ///
    /// There is no fallback to a direct insert if this fails: quietly writing
    /// the row ourselves would put every one of the above back in the client's
    /// hands. A failure surfaces to the artist instead.
    func createVersion(
        projectId: UUID,
        audioUrl: String,
        label: String?,
        audioFilename: String? = nil,
        durationSeconds: Int? = nil,
        fileSizeBytes: Int? = nil
    ) async throws -> Version {
        var body: [String: Any] = [
            "project_id": projectId.uuidString.lowercased(),
            "audio_url": audioUrl,
        ]
        // Omit rather than send NSNull: the route forwards these straight into
        // the insert, so a null would clobber a value a later heal or the web
        // app had already filled in.
        if let label { body["label"] = label }
        if let audioFilename { body["audio_filename"] = audioFilename }
        if let durationSeconds { body["duration_seconds"] = durationSeconds }
        if let fileSizeBytes { body["file_size_bytes"] = fileSizeBytes }

        // 201 with the inserted row — same column shape PostgREST returns, so
        // Version decodes unchanged.
        let data = try await requestData(path: "/api/versions", method: "POST", body: body)
        return try decoder.decode(Version.self, from: data)
    }

    // MARK: - Loudness (Master Check)

    /// Persist a measured BS.1770-4 reading for one mix — the same endpoint and
    /// body shape the web Master Check writes, so both platforms share one
    /// measurement history. Non-finite values (silence measures as −∞) are
    /// omitted; the server treats absent and null identically.
    func saveLoudness(versionId: UUID, measurement: LoudnessMeasurement) async throws {
        var body: [String: Any] = ["gatedBlockCount": measurement.gatedBlockCount]
        if measurement.integratedLufs.isFinite { body["integratedLufs"] = measurement.integratedLufs }
        if measurement.shortTermMaxLufs.isFinite { body["shortTermMaxLufs"] = measurement.shortTermMaxLufs }
        if measurement.samplePeakDb.isFinite { body["samplePeakDb"] = measurement.samplePeakDb }
        _ = try await requestJSON(
            path: "/api/versions/\(versionId.uuidString.lowercased())/loudness",
            method: "POST",
            body: body
        )
    }

    private func requestJSON(path: String, method: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        let data = try await requestData(path: path, method: method, body: body)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MixbaseAPIError.invalidResponse("Response was not a JSON object")
        }
        return json
    }

    /// Perform an authenticated request. On 401, refreshes the Supabase session
    /// (coalesced in AuthService) and retries once with the new token. Non-2xx
    /// responses surface the server's own `error` message — that's where the
    /// tier-limit and upgrade prompts come from.
    private func requestData(path: String, method: String, body: [String: Any]? = nil) async throws -> Data {
        func makeRequest(token: String?) throws -> URLRequest {
            guard let url = URL(string: "\(baseURL)\(path)") else {
                throw MixbaseAPIError.invalidResponse("Bad URL: \(path)")
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            if let token {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            return request
        }

        var (data, response) = try await session.data(for: makeRequest(token: currentToken()))

        // Expired access token — refresh once and retry with the new one.
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let refreshed = await AuthService.shared.refreshSession()
            guard refreshed else { throw MixbaseAPIError.notAuthenticated }
            (data, response) = try await session.data(for: makeRequest(token: currentToken()))
        }

        guard let http = response as? HTTPURLResponse else {
            throw MixbaseAPIError.invalidResponse("Not an HTTP response")
        }
        guard (200...299).contains(http.statusCode) else {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                // Monthly tier limits come back with `upgrade: true`. On iOS there
                // is no in-app purchase, so we must NOT surface the web's
                // "Upgrade to generate more" copy — App Store Guideline 3.1.1
                // forbids steering users to an external purchase. Show neutral,
                // purchase-free copy instead.
                if (json["upgrade"] as? Bool) == true {
                    throw MixbaseAPIError.serverError("You've reached this month's limit for AI generations. It resets at the start of next month.")
                }
                // Otherwise prefer the server's own human-readable error — but
                // never trust it to be purchase-free. Belt-and-braces for
                // Guideline 3.1.1: if ANY server message mentions upgrading,
                // plans, pricing, or buying (flagged or not), replace it with
                // the same neutral copy rather than steering to a purchase.
                if let message = json["error"] as? String {
                    let purchaseWords = ["upgrade", "plan", "tier", "subscri", "purchase", "billing", "pricing", "credit", "buy "]
                    let lowered = message.lowercased()
                    if purchaseWords.contains(where: { lowered.contains($0) }) {
                        throw MixbaseAPIError.serverError("This action isn't available right now. Please try again later.")
                    }
                    throw MixbaseAPIError.serverError(message)
                }
            }
            throw MixbaseAPIError.httpError(statusCode: http.statusCode)
        }
        return data
    }

    /// The current Supabase access token, as persisted by AuthService.
    private func currentToken() -> String? {
        KeychainService.load(forKey: "access_token")
    }
}

// MARK: - MixbaseAPIError

enum MixbaseAPIError: LocalizedError {
    case notAuthenticated
    case serverError(String)
    case httpError(statusCode: Int)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Your session expired. Please sign in again."
        case .serverError(let message):
            return message
        case .httpError(let code):
            return "Request failed (HTTP \(code))"
        case .invalidResponse(let message):
            return message
        }
    }
}
