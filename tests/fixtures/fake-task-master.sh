#!/bin/sh
# Stand-in for the task-master command: records its arguments to $EE_TM_LOG and prints a line.
printf '%s\n' "$*" >> "${EE_TM_LOG:-/tmp/ee-tm.log}"
echo "ran $1"
