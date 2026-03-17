on run argv
	set artistName to item 1 of argv
	set albumName to item 2 of argv
	set outPath to item 3 of argv
	set tmpPath to outPath & ".raw"

	tell application "Music"
		set matchedTracks to {}
		try
			set matchedTracks to (every track whose album is albumName)
		end try
		repeat with t in matchedTracks
			try
				set a to ""
				try
					set a to album artist of t
				end try
				if a is "" then
					try
						set a to artist of t
					end try
				end if
				if a is artistName then
					set artList to artworks of t
					if (count of artList) > 0 then
						set artData to data of item 1 of artList
						set outFile to tmpPath as POSIX file
						set fileRef to open for access outFile with write permission
						set eof of fileRef to 0
						write artData to fileRef
						close access fileRef
						-- Convert to JPEG using sips
						do shell script "sips -s format jpeg " & quoted form of tmpPath & " --out " & quoted form of outPath & " > /dev/null 2>&1; rm -f " & quoted form of tmpPath
						return "ok"
					end if
					exit repeat
				end if
			end try
		end repeat
	end tell
	return "notfound"
end run
