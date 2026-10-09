; Prerequisite checks run by the installer. Anything that only needs a heads-up (Claude Code, an OpenAI
; key) is checked again, with fix-it buttons, by the app itself on first start.
!include "FileFunc.nsh"
!include "WinVer.nsh"

!macro customInit
  ; MangoAI needs Windows 10 or newer (64-bit is guaranteed by the installer's own x64 build).
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "MangoAI needs Windows 10 or newer."
    Quit
  ${EndIf}

  ; The app itself is about 1.5 GB installed; leave room for projects too.
  ${DriveSpace} "$LOCALAPPDATA" "/D=F /S=M" $R0
  ${If} $R0 < 2500
    MessageBox MB_OK|MB_ICONSTOP "MangoAI needs about 2.5 GB of free disk space to install. Free some space on your user drive and run the installer again."
    Quit
  ${EndIf}
!macroend

!macro customInstall
  ; Informational only: the Claude Code CLI is installed and signed in by the user, so a missing one does
  ; not stop the installation. The app walks through it on first start.
  IfSilent claude_done
  nsExec::ExecToStack 'cmd /c where claude'
  Pop $0
  Pop $1
  ${If} $0 != 0
    IfFileExists "$PROFILE\.local\bin\claude.exe" claude_done
    IfFileExists "$APPDATA\npm\claude.cmd" claude_done
    MessageBox MB_OK|MB_ICONINFORMATION "Heads-up: the Claude Code CLI was not found on this PC.$\r$\n$\r$\nMangoAI designs its animations with it. You can install it after setup: MangoAI will show you how the first time it starts.$\r$\n$\r$\n(An OpenAI API key is needed for transcription and voiceovers; the app asks for it.)"
  ${EndIf}
  claude_done:
!macroend
