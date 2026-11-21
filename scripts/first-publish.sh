#!/usr/bin/env bash
# Publishes fleetrc@0.0.0 by hand, once, to claim the name on npm. npm only lets
# you add a trusted publisher to a package that exists, and every later
# version goes out from release.yaml through that trusted publisher.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! user=$(npm whoami 2>/dev/null); then
  echo "You're not logged in to npm. Run npm login, then run this again." >&2
  exit 1
fi

name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')

if npm view "$name" name >/dev/null 2>&1; then
  echo "$name is already on npm, so there is nothing to claim. Skip to the trusted publisher below." >&2
  exit 1
fi

echo "Publishing $name@$version as $user"
pnpm install --frozen-lockfile
pnpm build
pnpm test

# publishConfig asks for provenance, which only CI can sign.
npm publish --access public --provenance=false

echo
echo "$name@$version is on npm: https://www.npmjs.com/package/$name"
echo
echo "Next, let release.yaml publish it."
# Older npm has no npm trust.
if npm trust github --help >/dev/null 2>&1; then
  cat <<EOF
Either run:

  npm trust github $name --file release.yaml --repo onmax/fleetrc --env npm --allow-publish

or, on npmjs.com, open https://www.npmjs.com/package/$name/access, and under
Trusted publishing pick GitHub Actions and fill in:
EOF
else
  cat <<EOF
Your npm has no npm trust, so on npmjs.com, open
https://www.npmjs.com/package/$name/access, and under Trusted publishing pick
GitHub Actions and fill in:
EOF
fi
cat <<EOF

  Organization or user: onmax
  Repository:           fleetrc
  Workflow filename:    release.yaml
  Environment name:     npm

The npm environment in GitHub already exists (Settings, Environments, npm).
Once the trusted publisher is saved, you can also set "Require two-factor
authentication and disallow tokens" under Publishing access, since nothing
publishes with a token after this.
EOF
