#!/bin/bash

# M.I.R.A. Auto-Update Script
# Pulls latest changes from GitHub and restarts the server
# Usage: bash update.sh

CYAN='\033[0;36m'
ORANGE='\033[0;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "  ${ORANGE}M.I.R.A. Update Script${NC}"
echo "  ─────────────────────────────"

# Check we're in the right folder
if [ ! -f "server.js" ]; then
  echo -e "  ${RED}Error: Run this from inside your mira-miwayz folder${NC}"
  echo "  cd Downloads/mira-miwayz"
  exit 1
fi

# Stop running server
echo -e "  ${CYAN}Stopping server...${NC}"
pkill -f "node server.js" 2>/dev/null && echo "  Server stopped" || echo "  Server was not running"

# Pull latest changes
echo -e "  ${CYAN}Pulling latest changes from GitHub...${NC}"
git pull origin main

if [ $? -ne 0 ]; then
  echo -e "  ${RED}Git pull failed. Check your internet connection.${NC}"
  exit 1
fi

echo -e "  ${GREEN}Files updated successfully${NC}"

# Show what changed
echo ""
echo -e "  ${CYAN}Recent changes:${NC}"
git log --oneline -5

# Restart server
echo ""
echo -e "  ${CYAN}Starting MIRA...${NC}"
npm start
