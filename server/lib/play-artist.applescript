on run argv
	set artistName to item 1 of argv
	set playlistName to "HA_Play_Artist"

	tell application "Music"
		-- Filter by albumArtist first (faster than scanning all fields)
		set matchedTracks to {}
		repeat with t in (every track whose album artist is artistName)
			set end of matchedTracks to t
		end repeat

		-- Fallback: try artist field if albumArtist match returned nothing
		if (count of matchedTracks) is 0 then
			repeat with t in (every track whose artist is artistName)
				set end of matchedTracks to t
			end repeat
		end if

		if (count of matchedTracks) is 0 then
			return "notfound"
		end if

		-- Sort by album, disc, track number (insertion sort)
		set n to count of matchedTracks
		repeat with i from 2 to n
			set pivot to item i of matchedTracks
			set pivotAlbum to album of pivot
			set pivotKey to (disc number of pivot) * 10000 + (track number of pivot)
			set j to i - 1
			repeat while j ≥ 1
				set jItem to item j of matchedTracks
				set jAlbum to album of jItem
				set jKey to (disc number of jItem) * 10000 + (track number of jItem)
				if jAlbum > pivotAlbum or (jAlbum = pivotAlbum and jKey > pivotKey) then
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
			delete (first user playlist whose name is playlistName)
		end try

		-- Create fresh temp playlist and add tracks in order
		set tempPL to make new user playlist with properties {name: playlistName}
		repeat with t in matchedTracks
			duplicate t to tempPL
		end repeat

		play tempPL
	end tell
	return "ok"
end run
