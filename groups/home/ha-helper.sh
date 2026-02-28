#!/bin/bash
# Home Assistant API Helper for NanoClaw

HA_URL="${HA_URL:-http://192.168.1.254:8123}"
HA_TOKEN="${HA_TOKEN:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjYmI4ZGE0NGI2MTQ0NjhhYmIwZTNlZDgwNTI3ZGViNiIsImlhdCI6MTc3MjI4Nzc2OSwiZXhwIjoyMDg3NjQ3NzY5fQ.5AQQXdGs9xCBIcAoNJj2fMlF4cMbSWw91ekTTNNhVWQ}"

ha_api() {
    local endpoint="$1"
    local method="${2:-GET}"
    local data="$3"

    if [ "$method" = "GET" ]; then
        curl -s -X GET \
            -H "Authorization: Bearer $HA_TOKEN" \
            -H "Content-Type: application/json" \
            "$HA_URL/api/$endpoint"
    else
        curl -s -X POST \
            -H "Authorization: Bearer $HA_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$HA_URL/api/$endpoint"
    fi
}

case "$1" in
    list)
        domain="$2"
        if [ -n "$domain" ]; then
            ha_api "states" | jq "[.[] | select(.entity_id | startswith(\"$domain.\"))]"
        else
            ha_api "states"
        fi
        ;;
    get)
        entity="$2"
        ha_api "states/$entity"
        ;;
    turn_on)
        entity="$2"
        domain="${entity%%.*}"
        brightness="$3"
        if [ -n "$brightness" ]; then
            data="{\"entity_id\": \"$entity\", \"brightness\": $brightness}"
        else
            data="{\"entity_id\": \"$entity\"}"
        fi
        ha_api "services/$domain/turn_on" POST "$data"
        ;;
    turn_off)
        entity="$2"
        domain="${entity%%.*}"
        data="{\"entity_id\": \"$entity\"}"
        ha_api "services/$domain/turn_off" POST "$data"
        ;;
    set_temp)
        entity="$2"
        temp="$3"
        data="{\"entity_id\": \"$entity\", \"temperature\": $temp}"
        ha_api "services/climate/set_temperature" POST "$data"
        ;;
    *)
        echo "Usage: ha-helper.sh {list|get|turn_on|turn_off|set_temp} [args...]"
        exit 1
        ;;
esac
