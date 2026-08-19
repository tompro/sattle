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
              # extensible: playwright browsers, capacitor/android SDK tooling,
              # etc. go here as the project grows
            ];

            shellHook = ''
              echo "sattle dev shell (node $(node --version))"
            '';
          };
        }
      );
    };
}
