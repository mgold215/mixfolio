import Foundation

// MARK: - Project
// Represents a music project (a track or song you're working on).
// Maps directly to the "mb_projects" table in Supabase.
// "Codable" means Swift can convert it to/from JSON automatically.
// "Identifiable" lets SwiftUI use it in lists without extra work.

struct Project: Codable, Identifiable {

    // Unique identifier for this project (matches the UUID primary key in Supabase)
    let id: UUID

    // The name of the project / track
    var title: String

    // Optional URL pointing to the cover artwork image
    var artworkUrl: String?

    // Optional genre tag (e.g. "House", "Hip-Hop")
    var genre: String?

    // Optional tempo in beats per minute
    var bpm: Int?

    // Optional musical key (e.g. "Am", "F#")
    var keySignature: String?

    // Optional pinned visualizer video URL (Spotify-Canvas-style loop)
    var visualizerUrl: String?

    // Optional pinned instrumental (no-vocals) audio URL — one per project,
    // stored beside the mixes in mf-audio (migration 035). Owner-private:
    // never part of share pages or the feed.
    var instrumentalUrl: String?

    // Project-level share token — /share/<token> resolves it to the LATEST
    // mix, which is why the web player shares this rather than a version
    // token. The Now Playing share button falls back to it when the playing
    // Version carries no token of its own (feed playback builds synthetic
    // Versions with shareToken nil, even for your own songs).
    var shareToken: String?

    // When this project was first created
    let createdAt: Date

    // When this project was last updated
    var updatedAt: Date

    // MARK: - CodingKeys
    // This tells Swift how to map our camelCase property names
    // to the snake_case column names used in Supabase / JSON.
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case artworkUrl = "artwork_url"
        case genre
        case bpm
        case keySignature = "key_signature"
        case visualizerUrl = "visualizer_url"
        case instrumentalUrl = "instrumental_url"
        case shareToken = "share_token"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}
