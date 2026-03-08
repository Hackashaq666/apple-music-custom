on run argv
	set artistName to item 1 of argv
	set albumName to item 2 of argv
	set playlistName to "HA_Play_Album"

	tell application "Music"
		-- Collect matching tracks
		set matchedTracks to {}
		repeat with t in (every track whose album is albumName)
			set a to ""
			try
				set a to album artist of t
			end try
			if a is "" then
				set a to artist of t
			end if
			if a is artistName then
				set end of matchedTracks to t
			end if
		end repeat

		if (count of matchedTracks) is 0 then
			return "notfound"
		end if

		-- Sort by disc then track number (insertion sort)
		set n to count of matchedTracks
		repeat with i from 2 to n
			set pivot to item i of matchedTracks
			set pivotKey to (disc number of pivot) * 10000 + (track number of pivot)
			set j to i - 1
			repeat while j ≥ 1
				set jKey to (disc number of item j of matchedTracks) * 10000 + (track number of item j of matchedTracks)
				if jKey > pivotKey then
					set item (j + 1) of matchedTracks to item j of matchedTracks
					set j to j - 1
				else
					exit repeat
				end if
			end repeat
			set item (j + 1) of matchedTracks to pivot
		end repeat

		-- Delete existing temp playlist if present
		try
			set oldPL to (first user playlist whose name is playlistName)
			delete oldPL
		end try

		-- Create fresh temp playlist and add tracks in order
		set tempPL to make new user playlist with properties {name: playlistName}
		repeat with t in matchedTracks
			duplicate t to tempPL
		end repeat

		-- Play the playlist from track 1
		play tempPL
	end tell
	return "ok"
end run
