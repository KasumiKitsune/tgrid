!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Praat TextGrid\DefaultIcon" "" "$\"$INSTDIR\icons\doc-textgrid.ico$\",0"
  WriteRegStr SHCTX "Software\Classes\Praat Collection\DefaultIcon" "" "$\"$INSTDIR\icons\doc-collection.ico$\",0"
  !insertmacro UPDATEFILEASSOC
!macroend
