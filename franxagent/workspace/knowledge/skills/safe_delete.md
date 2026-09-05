# skill: safe_delete
Deleting files must be replaced by moving them to a to-delete directory and recording a manifest for user recovery.
Steps: 1) mv <path> ./to-delete/  2) append the moved file entry to ./to-delete/manifest.log via write tool.
Never use rm/del/rmdir/shred through the command tool.
