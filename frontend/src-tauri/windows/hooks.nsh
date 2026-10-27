; Versions before 1.11.0 shipped a Python backend next to the app. The new app
; does not use it, and an upgrade over the old install would leave it behind.
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\pdf-manager-backend.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\pdf-manager-backend.exe"
!macroend
