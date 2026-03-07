on run argv
	set artistName to item 1 of argv
	set albumName to item 2 of argv
	set outPath to item 3 of argv

	tell application "Music"
		set matchedTracks to (every track whose album is albumName)
		repeat with t in matchedTracks
			set a to ""
			try
				set a to album artist of t
			end try
			if a is "" then
				set a to artist of t
			end if
			if a is artistName then
				set artList to artworks of t
				if (count of artList) > 0 then
					set artData to data of item 1 of artList
					set outFile to outPath as POSIX file
					set fileRef to open for access outFile with write permission
					set eof of fileRef to 0
					write artData to fileRef
					close access fileRef
					return "ok"
				end if
				exit repeat
			end if
		end repeat
	end tell
	return "notfound"
end run
