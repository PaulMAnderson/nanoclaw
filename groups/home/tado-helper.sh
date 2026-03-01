#!/bin/bash
# Tado API Helper for NanoClaw
# Requires OAuth2 authentication via device code flow

TADO_TOKEN_FILE="${TADO_TOKEN_FILE:-/workspace/group/.tado-token.json}"
TADO_API_BASE="https://my.tado.com/api/v2"
# New Tado OAuth2 endpoints (post-March 2025)
TADO_TOKEN_URL="https://login.tado.com/oauth2/token"
TADO_CLIENT_ID="1bb50063-6b0c-4d11-bd99-387f4a91cc46"

# Function to get access token from refresh token (libtado-compatible token file)
get_access_token() {
    if [ ! -f "$TADO_TOKEN_FILE" ]; then
        echo "Error: Not authenticated. Ask the agent to run 'python3 /workspace/group/tado-auth.py start'"
        exit 1
    fi

    REFRESH_TOKEN=$(python3 -c "import json,sys; print(json.load(open('$TADO_TOKEN_FILE'))['refresh_token'])")

    RESPONSE=$(curl -s -X POST "$TADO_TOKEN_URL" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "client_id=$TADO_CLIENT_ID" \
        -d "grant_type=refresh_token" \
        -d "refresh_token=$REFRESH_TOKEN")

    # Save new refresh token (Tado rotates it)
    NEW_REFRESH=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('refresh_token',''))" 2>/dev/null)
    if [ -n "$NEW_REFRESH" ]; then
        echo "{\"refresh_token\": \"$NEW_REFRESH\"}" > "$TADO_TOKEN_FILE"
        chmod 600 "$TADO_TOKEN_FILE"
    fi

    ACCESS_TOKEN=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('access_token',''))" 2>/dev/null)

    if [ -z "$ACCESS_TOKEN" ]; then
        echo "Error: Failed to get access token. Run tado-auth.py start again. Response: $RESPONSE"
        exit 1
    fi

    echo "$ACCESS_TOKEN"
}

# Function to call Tado API
tado_api() {
    local endpoint="$1"
    local method="${2:-GET}"
    local data="$3"

    ACCESS_TOKEN=$(get_access_token)

    if [ "$method" = "GET" ]; then
        curl -s -X GET \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            "$TADO_API_BASE/$endpoint"
    else
        curl -s -X "$method" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$TADO_API_BASE/$endpoint"
    fi
}

case "$1" in
    auth)
        # Delegate to the two-phase Python auth script
        python3 /workspace/group/tado-auth.py start
        ;;

    me)
        tado_api "me"
        ;;

    home)
        HOME_ID=$(tado_api "me" | grep -o '"homeId":[0-9]*' | head -1 | cut -d':' -f2)
        tado_api "homes/$HOME_ID"
        ;;

    zones)
        HOME_ID=$(tado_api "me" | grep -o '"homeId":[0-9]*' | head -1 | cut -d':' -f2)
        tado_api "homes/$HOME_ID/zones"
        ;;

    zone)
        ZONE_ID="$2"
        if [ -z "$ZONE_ID" ]; then
            echo "Usage: tado-helper.sh zone <zone_id>"
            exit 1
        fi
        HOME_ID=$(tado_api "me" | grep -o '"homeId":[0-9]*' | head -1 | cut -d':' -f2)
        tado_api "homes/$HOME_ID/zones/$ZONE_ID/state"
        ;;

    schedules)
        ZONE_ID="$2"
        if [ -z "$ZONE_ID" ]; then
            echo "Usage: tado-helper.sh schedules <zone_id>"
            exit 1
        fi
        HOME_ID=$(tado_api "me" | grep -o '"homeId":[0-9]*' | head -1 | cut -d':' -f2)
        tado_api "homes/$HOME_ID/zones/$ZONE_ID/schedule/timetables"
        ;;

    schedule)
        ZONE_ID="$2"
        TIMETABLE_ID="${3:-0}"
        if [ -z "$ZONE_ID" ]; then
            echo "Usage: tado-helper.sh schedule <zone_id> [timetable_id]"
            exit 1
        fi
        HOME_ID=$(tado_api "me" | grep -o '"homeId":[0-9]*' | head -1 | cut -d':' -f2)
        tado_api "homes/$HOME_ID/zones/$ZONE_ID/schedule/timetables/$TIMETABLE_ID/blocks"
        ;;

    set_schedule)
        ZONE_ID="$2"
        TIMETABLE_ID="$3"
        BLOCKS="$4"
        if [ -z "$ZONE_ID" ] || [ -z "$TIMETABLE_ID" ] || [ -z "$BLOCKS" ]; then
            echo "Usage: tado-helper.sh set_schedule <zone_id> <timetable_id> <blocks_json>"
            exit 1
        fi
        HOME_ID=$(tado_api "me" | grep -o '"homeId":[0-9]*' | head -1 | cut -d':' -f2)
        tado_api "homes/$HOME_ID/zones/$ZONE_ID/schedule/timetables/$TIMETABLE_ID/blocks" "PUT" "$BLOCKS"
        ;;

    *)
        echo "Usage: tado-helper.sh {auth|me|home|zones|zone|schedules|schedule|set_schedule} [args...]"
        echo ""
        echo "Commands:"
        echo "  auth                           - Authenticate with Tado (first time setup)"
        echo "  me                             - Get user info"
        echo "  home                           - Get home info"
        echo "  zones                          - List all zones"
        echo "  zone <zone_id>                 - Get zone state"
        echo "  schedules <zone_id>            - Get available schedule timetables"
        echo "  schedule <zone_id> [timetable] - Get schedule blocks (default timetable 0)"
        echo "  set_schedule <zone> <tt> <json> - Set schedule blocks"
        exit 1
        ;;
esac
