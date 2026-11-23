/**
 * Playback limits shared by the media route and the player (no server dependencies).
 *
 * Accounts without the footage-download right only ever receive recordings as
 * fragmented MP4 in windows of at most this many seconds; the player chains the
 * windows. A full-length or non-fragmented (single-file) MP4 is a download.
 */
export const VIEW_ONLY_CLIP_SECONDS = 15 * 60;
