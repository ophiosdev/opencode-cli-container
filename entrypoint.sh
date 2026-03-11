#!/usr/bin/env bash

###
# Ensure MISE configuration is loaded
source /etc/bash.bashrc

exec /usr/local/bin/opencode "$@"
