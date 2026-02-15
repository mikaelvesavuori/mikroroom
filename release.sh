#!/bin/bash

set -e  # Exit on error

# Setup variables
VERSION="${npm_package_version:-$(npm pkg get version | tr -d '"')}"
TEMP_RELEASE_FOLDER="mikroroom"

# Remove old stuff
rm -rf $TEMP_RELEASE_FOLDER ./*.zip VERSION

# Build the code
npm run build

# Create temporary release folder
mkdir -p $TEMP_RELEASE_FOLDER
mkdir -p $TEMP_RELEASE_FOLDER/app
mkdir -p $TEMP_RELEASE_FOLDER/api

# Copy build artifacts
cp -r dist/* $TEMP_RELEASE_FOLDER/

# Create VERSION file
echo "$VERSION" > $TEMP_RELEASE_FOLDER/VERSION

# Copy LICENSE
cp LICENSE $TEMP_RELEASE_FOLDER/

# Copy README
cp README.md $TEMP_RELEASE_FOLDER/README.md

# Create SBOM
npm run sbom
cp sbom.json $TEMP_RELEASE_FOLDER/sbom.json

# Create OSS license list
npm run licenses
[ -f oss-licenses.txt ] && mv oss-licenses.txt $TEMP_RELEASE_FOLDER/oss-licenses.txt

# Create zip archives
zip -r "mikroroom_${VERSION}.zip" $TEMP_RELEASE_FOLDER
zip -r "mikroroom_latest.zip" $TEMP_RELEASE_FOLDER

# Copy standalone VERSION file for upgrade checks
cp $TEMP_RELEASE_FOLDER/VERSION VERSION

# Cleanup
rm -rf $TEMP_RELEASE_FOLDER
