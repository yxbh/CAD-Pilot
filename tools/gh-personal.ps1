param(
    [switch]$Git,
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$GitHubArguments
)

$ErrorActionPreference = 'Stop'
if (-not $GitHubArguments) { throw 'Provide a GitHub CLI command, or use -Git with a Git command.' }
if (-not $Git -and $GitHubArguments[0] -eq 'auth') { throw 'Manage authentication directly in your terminal, not through this wrapper.' }
$PreviousToken = $env:GH_TOKEN
try {
    $PersonalToken = & gh auth token --hostname github.com --user yxbh
    if ($LASTEXITCODE -ne 0 -or -not $PersonalToken) {
        throw 'Sign in to the yxbh GitHub account in your terminal before using this wrapper.'
    }
    $env:GH_TOKEN = $PersonalToken
    if ($Git) {
        & git -c credential.helper= -c 'credential.helper=!gh auth git-credential' @GitHubArguments
    } else {
        & gh @GitHubArguments
    }
    if ($LASTEXITCODE -ne 0) { throw "Personal GitHub command failed with exit code $LASTEXITCODE" }
} finally {
    $env:GH_TOKEN = $PreviousToken
    $PersonalToken = $null
}