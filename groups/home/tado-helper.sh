#!/bin/bash
# Tado API Helper for NanoClaw
# Requires OAuth2 authentication via device code flow

TADO_TOKEN_FILE="${TADO_TOKEN_FILE:-/workspace/group/.tado-token.json}"
TADO_API_BASE="https://my.tado.com/api/v2"
TADO_TOKEN_URL="https://login.tado.com/oauth2/token"
TADO_CLIENT_ID="1bb50063-6b0c-4d11-bd99-387f4a91cc46"

# Rotate the refresh token and cache the access token ONCE at startup.
# Bash subshells inherit but cannot update parent variables, so we must
# initialize ACCESS_TOKEN and HOME_ID in the global scope before any $(…)
# subshell runs — otherwise each subshell would rotate the token again.

_init_token() {
    if [ ! -f "$TADO_TOKEN_FILE" ]; then
        echo "Error: Not authenticated. Run 'tado-helper.sh auth' first." >&2
        exit 1
    fi

    local REFRESH RESPONSE NEW_REFRESH
    REFRESH=$(python3 -c "import json; print(json.load(open('$TADO_TOKEN_FILE'))['refresh_token'])")

    RESPONSE=$(curl -s -X POST "$TADO_TOKEN_URL" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -H "User-Agent: python/libtado" \
        -d "client_id=$TADO_CLIENT_ID" \
        -d "grant_type=refresh_token" \
        -d "refresh_token=$REFRESH")

    NEW_REFRESH=$(echo "$RESPONSE" | jq -r '.refresh_token // empty' 2>/dev/null)
    if [ -n "$NEW_REFRESH" ]; then
        echo "{\"refresh_token\": \"$NEW_REFRESH\"}" > "$TADO_TOKEN_FILE"
    fi

    ACCESS_TOKEN=$(echo "$RESPONSE" | jq -r '.access_token // empty' 2>/dev/null)
    if [ -z "$ACCESS_TOKEN" ]; then
        echo "Error: Token refresh failed: $(echo "$RESPONSE" | jq -r '.error_description // .error // .')" >&2
        exit 1
    fi
}

tado_api() {
    local endpoint="$1" method="${2:-GET}" data="$3"
    if [ "$method" = "GET" ]; then
        curl -s -X GET \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -H "User-Agent: python/libtado" \
            "$TADO_API_BASE/$endpoint"
    else
        curl -s -X "$method" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -H "User-Agent: python/libtado" \
            -d "$data" \
            "$TADO_API_BASE/$endpoint"
    fi
}

# Initialize access token once (skip for auth command)
if [ "$1" != "auth" ]; then
    _init_token
    # Extract home ID from the JWT payload — no extra API call needed.
    # The access token is a JWT; its payload (middle segment) contains tado_homes[0].id.
    HOME_ID=$(echo "$ACCESS_TOKEN" | python3 -c "
import sys, json, base64
token = sys.stdin.read().strip()
payload = token.split('.')[1]
payload += '=' * (4 - len(payload) % 4)
payload = payload.replace('-', '+').replace('_', '/')
data = json.loads(base64.b64decode(payload))
print(data['tado_homes'][0]['id'])
")
fi

case "$1" in
    auth)
        python3 /workspace/group/tado-auth.py start
        ;;

    me)
        tado_api "me"
        ;;

    home)
        tado_api "homes/$HOME_ID"
        ;;

    zones)
        tado_api "homes/$HOME_ID/zones"
        ;;

    zone)
        [ -z "$2" ] && { echo "Usage: tado-helper.sh zone <zone_id>" >&2; exit 1; }
        tado_api "homes/$HOME_ID/zones/$2/state"
        ;;

    schedules)
        [ -z "$2" ] && { echo "Usage: tado-helper.sh schedules <zone_id>" >&2; exit 1; }
        tado_api "homes/$HOME_ID/zones/$2/schedule/timetables"
        ;;

    schedule)
        [ -z "$2" ] && { echo "Usage: tado-helper.sh schedule <zone_id> [timetable_id]" >&2; exit 1; }
        tado_api "homes/$HOME_ID/zones/$2/schedule/timetables/${3:-0}/blocks"
        ;;

    set_schedule)
        { [ -z "$2" ] || [ -z "$3" ] || [ -z "$4" ]; } && { echo "Usage: tado-helper.sh set_schedule <zone_id> <timetable_id> <blocks_json>" >&2; exit 1; }
        tado_api "homes/$HOME_ID/zones/$2/schedule/timetables/$3/blocks" "PUT" "$4"
        ;;

    *)
        echo "Usage: tado-helper.sh {auth|me|home|zones|zone|schedules|schedule|set_schedule} [args...]" >&2
        exit 1
        ;;
esac
