on run argv
	set systemNames to {"Library", "Music", "Music Videos", "TV & Movies", "Podcasts", "Audiobooks", "Voice Memos", "Genius", "iTunes U", "Downloaded Music", "Recently Added", "Recently Played", "Top 25 Most Played", "Top Rated", "Purchased"}
	set NL to (ASCII character 10)
	set output to ""

	tell application "Music"
		-- Two Apple Events for the whole library instead of two per playlist.
		set plNames to name of every playlist
		set plIds to id of every playlist
		repeat with i from 1 to count of plNames
			set plName to item i of plNames
			-- HA_Play_* Playlists überspringen
			if plName starts with "HA_Play_" or plName is in systemNames then
				-- skip
			else
				set plId to item i of plIds
				-- mediaKind bestimmen: video-only wenn alle Tracks Musikvideos sind.
				-- Music evaluates the `whose` filter itself, so a normal playlist
				-- costs one request instead of a fetch of every track reference;
				-- only empty or all-video playlists need the second request.
				set plKind to "song"
				try
					set pl to playlist id plId
					if (count of (every track of pl whose media kind is not music video)) = 0 then
						if (count of (every track of pl whose media kind is music video)) > 0 then set plKind to "music video"
					end if
				end try
				set output to output & plId & tab & plName & tab & plKind & NL
			end if
		end repeat
	end tell
	return output
end run
