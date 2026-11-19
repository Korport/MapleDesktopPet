// Local stand-in for the real `aws4` package (AWS request-signing helper).
//
// Maple's only use of the `electron-builder` toolchain is local packaging
// (`npm run dist` / `dist:dir`) into an NSIS installer — it never configures
// an S3/Spaces/GitHub-release "publish" target. `aws4` is pulled in
// transitively only by `electron-publish`'s S3-publishing code path, which
// is never loaded unless a publish target is configured. Nothing in the
// installed `electron-builder`/`app-builder-lib`/`electron-publish`/
// `builder-util-runtime` code actually `require()`s `aws4` outside that
// unused path (verified by searching those packages for the string
// "aws4").
//
// Rather than installing the real package just to satisfy a devDependency
// version range, this stub is swapped in via an npm "overrides" entry in
// package.json (see that file). It implements just enough of aws4's public
// API shape to fail loudly and clearly if anything, now or in the future,
// actually tries to use it for real AWS request signing.
function sign() {
  throw new Error(
    'aws4.sign() was called, but Maple uses a no-op aws4 stub (see vendor/aws4-stub). ' +
      'If you need real AWS request signing (e.g. configuring an S3/Spaces publish target ' +
      'for electron-builder), remove the "aws4" override in package.json so the real ' +
      "`aws4` package installs normally."
  );
}

module.exports = { sign };
module.exports.sign = sign;
