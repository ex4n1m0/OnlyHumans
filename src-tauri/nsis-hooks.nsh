; NSIS installer hooks (wired via bundle.windows.nsis.installerHooks).
;
; Product rule: every install is a clean install. Rooms are ephemeral and
; the global key epoch moves with the release channel, so state left behind
; by an older build (identity, room cache, webview profile) is never
; compatible baggage — it is stale test residue that makes a fresh install
; open mid-conversation. Wipe both data dirs before the new files land.

!macro NSIS_HOOK_PREINSTALL
  ; Roaming: identity.key, device.key, username.txt, onlyhumans.db, logs/
  RMDir /r "$APPDATA\space.deepflux.onlyhumans"
  ; Local: EBWebView profile cache
  RMDir /r "$LOCALAPPDATA\space.deepflux.onlyhumans"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Uninstall leaves the machine exactly as it found it: the two data dirs
  ; and the NSIS remember-key (Software\<publisher>\<product>, kept in sync
  ; with bundle.publisher) — the template itself never deletes the latter,
  ; so a reinstall-after-uninstall would otherwise prefill the old path.
  RMDir /r "$APPDATA\space.deepflux.onlyhumans"
  RMDir /r "$LOCALAPPDATA\space.deepflux.onlyhumans"
  DeleteRegKey HKCU "Software\DeepFlux\OnlyHumans"
!macroend
