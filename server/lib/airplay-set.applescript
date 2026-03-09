-- argv: id, action ("on"/"off"), optional volume level
on run argv
	set dId to item 1 of argv
	set action to item 2 of argv
	set cleanId to do shell script "echo " & quoted form of dId & " | sed 's/-/:/g'"

	tell application "Music"
		repeat with d in every AirPlay device
			set dAddr to ""
			try
				set dAddr to network address of d
			end try
			if dAddr is missing value then set dAddr to ""
			if dAddr is cleanId or name of d is dId then
				if action is "on" then
					set selected of d to true
				else if action is "off" then
					set selected of d to false
				else if action is "volume" then
					set level to (item 3 of argv) as integer
					set sound volume of d to level
				end if
				return "ok"
			end if
		end repeat
	end tell
	return "notfound"
end run
