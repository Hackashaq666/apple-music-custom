on run argv
	set artistName to item 1 of argv
	set playlistName to "HA_Play_Artist"

	tell application "Music"
		-- Collect all tracks by this artist
		set matchedTracks to {}
		repeat with t in every track
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

		-- Sort by album, disc, track number
		set n to count of matchedTracks
		repeat with i from 2 to n
			set pivot to item i of matchedTracks
			set pivotAlbum to album of pivot
			set pivotDisc to disc number of pivot
			set pivotTrack to track number of pivot
			set j to i - 1
			repeat while j ≥ 1
				set jItem to item j of matchedTracks
				set jAlbum to album of jItem
				set jDisc to disc number of jItem
				set jTrack to track number of jItem
				if jAlbum > pivotAlbum or (jAlbum = pivotAlbum and (jDisc * 10000 + jTrack) > (pivotDisc * 10000 + pivotTrack)) then
					set item (j + 1) of matchedTracks to jItem
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

		-- Play from track 1
		play tempPL
	end tell
	return "ok"
end run
