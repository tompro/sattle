{
  description = "sattle - end-user wallet for LNURLcash (LUD-25) Lightning bearer notes.";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              # lnurlcash-kit requires node >= 22
              nodejs_22
              corepack_22
              git
              # Android SDK/gradle are deliberately NOT provided via
              # nixpkgs androidenv: composeAndroidPackages is heavy and
              # fragile, and `npx cap sync android` needs no SDK. For
              # native builds install Android Studio (or cmdline-tools +
              # `sdkmanager "platforms;android-35" "build-tools"`) locally
              # and point ANDROID_HOME at it; the gradle wrapper in
              # android/ does the rest.
            ]
            # playwright e2e drives the system chromium (see
            # playwright.config.ts); nixpkgs chromium is linux-only
            ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ chromium ];

            shellHook = ''
              echo "sattle dev shell (node $(node --version))"
              ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
                export CHROMIUM_PATH="${pkgs.chromium}/bin/chromium"
                echo "playwright e2e chromium: $CHROMIUM_PATH"
              ''}
            '';
          };
        }
      );
    };
}
