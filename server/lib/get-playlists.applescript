on run argv
	set HA_PLAY_ALBUM to "HA_Play_Album"
	set HA_PLAY_ARTIST to "HA_Play_Artist"
	set output to ""

	tell application "Music"
		repeat with pl in (every user playlist)
			try
				set plName to name of pl
				if plName is not HA_PLAY_ALBUM and plName is not HA_PLAY_ARTIST then
					set plId to id of pl
					set output to output & plId & "	" & plName & "
"
				end if
			end try
		end repeat
	end tell
	return output
end run
