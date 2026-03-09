on run argv
	set plId to item 1 of argv
	tell application "Music"
		repeat with pl in every playlist
			try
				if (id of pl as string) is plId then
					play pl
					return "ok"
				end if
			end try
		end repeat
	end tell
	return "notfound"
end run
