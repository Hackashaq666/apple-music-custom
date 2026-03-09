on run argv
	set NL to (ASCII character 10)
	set output to ""
	tell application "Music"
		repeat with d in every AirPlay device
			set dName to name of d
			set dKind to kind of d as string
			set dActive to active of d
			set dSelected to selected of d
			set dVolume to sound volume of d
			set dAudio to supports audio of d
			set dVideo to supports video of d
			try
				set dAddr to network address of d
			on error
				set dAddr to ""
			end try
			if dAddr is missing value then set dAddr to ""
			if dAddr is "" then
				set dId to dName
			else
				set dId to dAddr
			end if
			set output to output & dId & tab & dName & tab & dKind & tab & (dActive as string) & tab & (dSelected as string) & tab & (dVolume as string) & tab & (dAudio as string) & tab & (dVideo as string) & tab & dAddr & NL
		end repeat
	end tell
	return output
end run
