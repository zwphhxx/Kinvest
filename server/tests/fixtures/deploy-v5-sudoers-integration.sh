#!/bin/bash
set -euo pipefail
set +x

fail() {
  printf '%s\n' "deploy-v5 sudoers integration failed: $1" >&2
  exit 1
}

[[ "$#" -eq 1 ]] || fail 'invalid arguments'
[[ "$(/usr/bin/id -u)" -eq 0 ]] || fail 'root required'

template="$1"
for executable in \
  /usr/bin/cat /usr/bin/chmod /usr/bin/chown /usr/bin/env /usr/bin/getent /usr/bin/grep \
  /usr/bin/install /usr/bin/od /usr/bin/rm /usr/bin/sort /usr/bin/sudo /usr/bin/tr \
  /usr/sbin/runuser /usr/sbin/useradd /usr/sbin/userdel /usr/sbin/visudo; do
  [[ -x "$executable" ]] || fail "required executable unavailable: $executable"
done
[[ -f "$template" && ! -L "$template" ]] || fail 'sudoers template must be a regular file'

suffix="$(/usr/bin/od -An -N6 -tx1 /dev/urandom | /usr/bin/tr -d ' \n')"
[[ "$suffix" =~ ^[0-9a-f]{12}$ ]] || fail 'random identity generation failed'
test_user="kinv5t${suffix}"
test_root="/run/kinvest-v5-sudoers-test.${suffix}"
test_command="/usr/local/bin/kinvest-v5-sudo-test-${suffix}"
installed_policy="/etc/sudoers.d/kinvest-v5-test-${suffix}"
user_created=0
cleanup_failed=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ -e "$installed_policy" || -L "$installed_policy" ]]; then
    /usr/bin/rm -f -- "$installed_policy" || cleanup_failed=1
  fi
  if [[ -e "$test_command" || -L "$test_command" ]]; then
    /usr/bin/rm -f -- "$test_command" || cleanup_failed=1
  fi
  if [[ "$user_created" -eq 1 ]]; then
    /usr/sbin/userdel -f "$test_user" >/dev/null 2>&1 || cleanup_failed=1
  fi
  /usr/bin/rm -rf -- "$test_root" || cleanup_failed=1
  [[ ! -e "$installed_policy" && ! -L "$installed_policy" ]] || cleanup_failed=1
  [[ ! -e "$test_command" && ! -L "$test_command" ]] || cleanup_failed=1
  if /usr/bin/getent passwd "$test_user" >/dev/null 2>&1; then cleanup_failed=1; fi
  if [[ "$cleanup_failed" -ne 0 ]]; then
    printf '%s\n' 'deploy-v5 sudoers integration failed: cleanup failed' >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[[ ! -e "$test_root" && ! -L "$test_root" ]] || fail 'test root collision'
[[ ! -e "$test_command" && ! -L "$test_command" ]] || fail 'test command collision'
[[ ! -e "$installed_policy" && ! -L "$installed_policy" ]] || fail 'sudoers policy collision'
if /usr/bin/getent passwd "$test_user" >/dev/null 2>&1; then fail 'test user collision'; fi

/usr/bin/install -d -o root -g root -m 0700 "$test_root"
/usr/bin/install -o root -g root -m 0600 "$template" "$test_root/template"
/usr/bin/cat >"$test_root/command" <<'COMMAND'
#!/bin/sh
printf 'argc=%s\n' "$#"
/usr/bin/env | /usr/bin/sort
COMMAND
/usr/bin/install -o root -g root -m 0755 "$test_root/command" "$test_command"

user_created=1
/usr/sbin/useradd --system --no-create-home --no-user-group --shell /usr/sbin/nologin "$test_user"

if /usr/bin/sudo -n -l -U "$test_user" >/dev/null 2>&1; then
  fail 'new test user already has sudo authorization'
fi

if /usr/sbin/runuser -u "$test_user" -- /usr/bin/sudo -n /usr/bin/true >/dev/null 2>&1; then
  fail 'new test user already has sudo authorization'
fi
if /usr/sbin/runuser -u "$test_user" -- /usr/bin/sudo -n "$test_command" >/dev/null 2>&1; then
  fail 'new test user bypasses the Kinvest policy'
fi

defaults_line='Defaults!/usr/local/sbin/deploy-kinvest-v5 env_reset,secure_path=/usr/local/sbin\:/usr/local/bin\:/usr/sbin\:/usr/bin\:/sbin\:/bin,set_home,!setenv'
command_line='@KINVEST_DEPLOY_GATE_USER@ ALL=(root) NOPASSWD:NOSETENV: /usr/local/sbin/deploy-kinvest-v5 ""'
/usr/bin/grep -Fx -- "$defaults_line" "$test_root/template" >/dev/null || fail 'expected Defaults contract missing'
/usr/bin/grep -Fx -- "$command_line" "$test_root/template" >/dev/null || fail 'expected command contract missing'
{
  printf 'Defaults!%s env_reset,secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin,set_home,!setenv\n' "$test_command"
  printf '%s ALL=(root) NOPASSWD:NOSETENV: %s ""\n' "$test_user" "$test_command"
} >"$test_root/policy"
/usr/bin/chown root:root "$test_root/policy"
/usr/bin/chmod 0440 "$test_root/policy"
/usr/sbin/visudo -cf "$test_root/policy" >/dev/null
/usr/bin/install -o root -g root -m 0440 "$test_root/policy" "$installed_policy"
/usr/sbin/visudo -cf /etc/sudoers >/dev/null

listing="$(/usr/bin/sudo -n -l -U "$test_user")" || fail 'installed policy is not listable'
[[ "$listing" == *"$test_command"* ]] || fail 'exact deploy-v5 command is not authorized'
[[ "$listing" != *'NOPASSWD: ALL'* ]] || fail 'test user inherited broad sudo authorization'

allowed="$(/usr/sbin/runuser -u "$test_user" -- /usr/bin/env \
  BASH_ENV=/attacker/bash-env PYTHONPATH=/attacker/python LD_PRELOAD=/attacker/library.so \
  SUDO_ASKPASS=/attacker/askpass SUDO_COMMAND=attacker \
  /usr/bin/sudo -n "$test_command")" || fail 'exact no-argument deploy-v5 command was rejected'
[[ "$allowed" == *$'argc=0'* ]] || fail 'allowed command received arguments'
for forbidden in BASH_ENV PYTHONPATH LD_PRELOAD SUDO_ASKPASS; do
  [[ "$allowed" != *$'\n'"${forbidden}="* && "$allowed" != "${forbidden}="* ]] || fail "malicious environment survived: $forbidden"
done
[[ "$allowed" != *'SUDO_COMMAND=attacker'* ]] || fail 'caller-controlled SUDO_COMMAND survived'

if /usr/sbin/runuser -u "$test_user" -- /usr/bin/sudo -n "$test_command" unexpected >/dev/null 2>&1; then
  fail 'unexpected deploy-v5 argument was authorized'
fi
if /usr/sbin/runuser -u "$test_user" -- /usr/bin/sudo -n -E "$test_command" >/dev/null 2>&1; then
  fail 'SETENV via -E was authorized'
fi
if /usr/sbin/runuser -u "$test_user" -- /usr/bin/sudo -n BASH_ENV=/attacker/bash-env "$test_command" >/dev/null 2>&1; then
  fail 'SETENV via variable assignment was authorized'
fi

printf '%s\n' 'deploy-v5 sudoers integration: PASS'
