# A minimal stand-in for npm's dsh.ps1 shim, for verifying process cleanup on
# Windows without a real dsh install. It just runs the bundled node script and
# forwards the CLI args, exactly like npm's generated .ps1 shim.
$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent
& node "$basedir\fake-dsh.js" $args
exit $LASTEXITCODE
