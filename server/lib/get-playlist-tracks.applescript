on run argv
	set plId to (item 1 of argv) as integer
	set TAB to (ASCII character 9)
	set NL  to (ASCII character 10)
	set output to ""

	tell application "Music"
		try
			set pl to playlist id plId
		on error
			return "notfound"
		end try
		repeat with t in every track of pl
			try
				set tId        to persistent ID of t
				set tName      to name of t
				set tArtist    to artist of t
				set tAlbArtist to album artist of t
				set tAlbum     to album of t
				-- mediaKind: "song" oder "music video"
				set tKind to "song"
				try
					if media kind of t is equal to music video then set tKind to "music video"
				end try
				set output to output & tId & TAB & tName & TAB & tArtist & TAB & tAlbArtist & TAB & tAlbum & TAB & tKind & NL
			end try
		end repeat
	end tell
	return output
end run
