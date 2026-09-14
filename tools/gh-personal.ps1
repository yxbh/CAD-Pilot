param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$GitHubArguments
)

$ErrorActionPreference = 'Stop'
if (-not $GitHubArguments) { throw 'Provide a GitHub CLI command, for example: api user --jq .login' }
if ($GitHubArguments[0] -eq 'auth') { throw 'Manage authentication directly in your terminal, not through this wrapper.' }
$PreviousToken = $env:GH_TOKEN
try {
    $PersonalToken = & gh auth token --hostname github.com --user yxbh
    if ($LASTEXITCODE -ne 0 -or -not $PersonalToken) {
        throw 'Sign in to the yxbh GitHub account in your terminal before using this wrapper.'
    }
    $env:GH_TOKEN = $PersonalToken
    & gh @GitHubArguments
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI failed with exit code $LASTEXITCODE" }
} finally {
    $env:GH_TOKEN = $PreviousToken
    $PersonalToken = $null
}