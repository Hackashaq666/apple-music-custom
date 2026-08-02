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
				-- HA_Play_* Playlists überspringen
				if plName starts with "HA_Play_" then
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
						-- mediaKind bestimmen: video-only wenn alle Tracks Musikvideos sind
						set plKind to "song"
						try
							set tList to tracks of pl
							set tCount to count of tList
							if tCount > 0 then
								set allVideo to true
								repeat with t in tList
									if media kind of t is not music video then
										set allVideo to false
										exit repeat
									end if
								end repeat
								if allVideo then set plKind to "music video"
							end if
						end try
						set output to output & plId & tab & plName & tab & plKind & NL
					end if
				end if
			end try
		end repeat
	end tell
	return output
end run
