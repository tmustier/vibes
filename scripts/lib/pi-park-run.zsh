# A separate source context keeps Ctrl-Z from aborting the relaunch loop.
# Preserve the child's status even when zsh handles its terminating signal.
{
	if [[ ${(j: :)${(v)jobstates}} == *suspended:* ]]; then
		fg > /dev/null
	else
		"$real_pi" "${args[@]}"
	fi
} always {
	status_code=$?
	TRY_BLOCK_INTERRUPT=0
}
