on run argv
	set HA_PLAY_ALBUM to "HA_Play_Album"
	set HA_PLAY_ARTIST to "HA_Play_Artist"
	set systemNames to {"Library", "Music", "Music Videos", "TV & Movies", "Podcasts", "Audiobooks", "Voice Memos", "Genius", "iTunes U", "Downloaded Music", "Recently Added", "Recently Played", "Top 25 Most Played", "Top Rated", "Purchased"}
	set NL to (ASCII character 10)
	set output to ""

	tell application "Music"
		repeat with pl in every playlist
			try
				set plName to name of pl
				if plName is HA_PLAY_ALBUM or plName is HA_PLAY_ARTIST then
					-- skip
				else
					set isSystem to false
					repeat with sn in systemNames
						if plName is sn then
							set isSystem to true
							exit repeat
						end if
					end repeat
					if not isSystem then
						set plId to id of pl
						set output to output & plId & tab & plName & NL
					end if
				end if
			end try
		end repeat
	end tell
	return output
end run
