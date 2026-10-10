# synkro

Keep `develop` and `main` in sync and bump the version with semver, in any git repo.

## Install

```sh
npm i -g synkro
```

## Usage

```sh
synkro init                 # create main/develop if missing and push them (works right after git init)
synkro sync                 # merge develop into main, bump minor, tag, push
synkro sync --patch         # same, patch bump (--major for major)
synkro sync --dry-run       # show what would happen, change nothing
synkro status               # branches, versions, last tag
```

Work on `develop`. When you want a release, run `synkro sync`:

1. Merges `develop` into `main` with a single merge commit that also contains the new version.
2. Tags it `vX.Y.Z` with a changelog of the commits since the previous tag.
3. Fast-forwards `develop` to `main`, so both branches end up on the same commit.
4. Pushes both branches and the tag.

No extra "bump version" commits, no git hooks, nothing copied into your project.

## Configuration (optional)

Add a `synkro` key to `package.json`, or a `.synkrorc.json` file:

```json
{
  "main": "master",
  "develop": "develop",
  "remote": "origin",
  "bump": "minor",
  "skipIfOnly": ["*.md"]
}
```

Without config, synkro uses `main` or `master`, whichever exists.
Projects without a `package.json` take their version from the latest `vX.Y.Z` git tag.
No version yet? It counts as `0.0.0`, so the first `synkro sync` releases `0.1.0`.

## Development

```sh
npm install
npm run dev -- --help       # run the CLI from source (Node 24)
npm test
npm run build               # compile to dist/
```

## License

[GPL-3.0-only](./LICENSE) © Enrique Quero
