on run argv
	set plId to (item 1 of argv) as integer
	tell application "Music"
		try
			play (playlist id plId)
			return "ok"
		on error
			return "notfound"
		end try
	end tell
end run
