# Publish a new version as a GitHub Release.
#   1. bump "version" in manifest.json, update CHANGELOG.md, commit + push
#   2. run:  ./release.ps1
# Builds dist/personal-clickup-manager-v<version>.zip (extension files only),
# tags v<version> and creates the GitHub Release with the zip attached.
# Needs: git, node (syntax check), GitHub CLI signed in (gh auth login).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
Write-Host "Releasing $tag"

# Refuse to release uncommitted work or an existing tag.
if (git status --porcelain) { throw "Uncommitted changes - commit (and push) first." }
if (git tag --list $tag) { throw "Tag $tag already exists - bump the version in manifest.json." }

# Syntax check every script that ships.
$js = @("background.js", "popup.js", "options.js", "offscreen.js", "update.js", "lib-unzip.js", "lib-automation.js", "lib-availability.js", "lib-clickup.js", "lib-crypto.js", "lib-drive.js")
foreach ($f in $js) { node --check $f; if ($LASTEXITCODE -ne 0) { throw "Syntax error in $f" } }

# Package only what the extension needs.
$files = @("manifest.json", "background.js", "popup.html", "popup.js", "options.html", "options.js", "offscreen.html", "offscreen.js", "update.html", "update.js", "lib-unzip.js",
  "lib-automation.js", "lib-availability.js", "lib-clickup.js", "lib-crypto.js", "lib-drive.js", "icons", "sounds", "README.md", "CHANGELOG.md")
New-Item -ItemType Directory -Force dist | Out-Null
$zip = "dist/personal-clickup-manager-$tag.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $files -DestinationPath $zip
Write-Host "Built $zip"

# Release notes = only this version's section of CHANGELOG.md ("## v<version>" up to the next "## ").
$notes = "dist/notes-$tag.md"
$lines = Get-Content CHANGELOG.md
$start = ($lines | Select-String -Pattern ("^## " + [regex]::Escape($tag) + "") | Select-Object -First 1).LineNumber
if (-not $start) { throw "CHANGELOG.md has no ## $tag section - add one first." }
$section = @(); for ($i = $start; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^## ") { break }; $section += $lines[$i] }
$section -join "`n" | Set-Content -Encoding utf8 $notes
git push
git tag $tag
git push origin $tag
gh release create $tag $zip --title "$tag" --notes-file $notes
Write-Host "Published $tag - installed copies will see it within ~12 hours."
