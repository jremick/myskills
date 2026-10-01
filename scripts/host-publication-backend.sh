# Read-only script supplied on stdin through the existing supervisor adapter.
# Adapter MUST target the already-running Engine namespace, never start a distro.
set -eu
unavailable() { printf '%s\n' '{"category":"unavailable","bridgeAddress":"unavailable","forwarding":"unavailable","listener":"unavailable"}'; exit 0; }
# Pipeline status is necessary: permission/tool failures cannot mean absent rules.
(set -o pipefail) 2>/dev/null || unavailable
set -o pipefail
gateway=$1
address=$2
# Fixture publication is fixed loopback; gateway remains the owned bridge proof.
publication=127.0.0.1
for tool in timeout ip iptables ss readlink awk; do command -v "$tool" >/dev/null 2>&1 || unavailable; done
daemon=
count=0
for entry in /proc/[0-9]*/comm; do
  count=$((count + 1)); [ "$count" -le 4096 ] || unavailable
  comm=; read -r comm < "$entry" 2>/dev/null || continue
  if [ "$comm" = dockerd ]; then [ -z "$daemon" ] || unavailable; daemon=${entry%/comm}; fi
done
[ -n "$daemon" ] || unavailable
namespace=$(readlink "$daemon/ns/net") || unavailable
[ "$namespace" = "${3:-}" ] || unavailable
[ "$namespace" = "$(readlink /proc/self/ns/net)" ] || unavailable
# All output is filtered here; overflow or failed commands are unavailable.
bridge=$(timeout -k 0.25 -s TERM 2 ip -o -4 address show to "$gateway/32" 2>/dev/null | awk -v g="$gateway" 'BEGIN{n=0;b=0} {b+=length($0)+1;if(b>32768)exit 2;for(i=1;i<=NF;i++)if($i=="inet"&&index($(i+1),g"/")==1)n++} END{if(b<=32768)print n}') || unavailable
port=$(timeout -k 0.25 -s TERM 2 iptables -t nat -S DOCKER 2>/dev/null | awk -v a="$address:9000" -v g="$publication" 'BEGIN{b=0;n=0;p=""} {b+=length($0)+1;if(b>32768)exit 2;tcp=0;dst=0;host=0;v="";for(i=1;i<=NF;i++){if($i=="-p"&&$(i+1)=="tcp")tcp=1;if($i=="--to-destination"&&$(i+1)==a)dst=1;if($i=="-d"&&$(i-1)!="!"&&($(i+1)==g||$(i+1)==g"/32"))host=1;if($i=="--dport")v=$(i+1)}if(tcp&&dst&&host&&v~/^[0-9]+$/&&v>0&&v<=65535){n++;p=v}} END{if(b<=32768){if(n==1)print p;else if(n==0)print 0;else print -1}}') || unavailable
forwarding=absent; listener=unavailable
if [ "$port" -gt 0 ]; then
  forwarding=present
  sockets=$(timeout -k 0.25 -s TERM 2 ss -H -ltn "src $publication" "sport = :$port" 2>/dev/null | awk 'BEGIN{b=0;n=0}{b+=length($0)+1;if(b>32768)exit 2;n++}END{if(b<=32768)print n}') || unavailable
  listener=absent; [ "$sockets" -eq 0 ] || listener=present
elif [ "$port" -lt 0 ]; then unavailable; fi
comm=; read -r comm < "$daemon/comm" 2>/dev/null || unavailable
if [ "$comm" != dockerd ] || [ "$(readlink "$daemon/ns/net")" != "$namespace" ] || [ "$(readlink /proc/self/ns/net)" != "$namespace" ]; then
  printf '%s\n' '{"category":"namespace-changed","bridgeAddress":"unavailable","forwarding":"unavailable","listener":"unavailable"}'; exit 0
fi
bridgeCategory=absent; [ "$bridge" -eq 1 ] && bridgeCategory=present
printf '{"category":"observed","bridgeAddress":"%s","forwarding":"%s","listener":"%s","observedPort":"%s"}\n' "$bridgeCategory" "$forwarding" "$listener" "$port"
