# ARKS Shop

Boilerplate Foundry VTT module scaffold for an ARKS system shop module.

## Included

- `module.json` manifest with Foundry package metadata
- `scripts/main.js` entry point with `init` and `ready` hooks
- `game.ARKSShop.openShop()` API helper
- `templates/shop-shell.hbs` starter application shell
- `styles/arks-shop.css` starter styles
- `lang/en.json` localization strings

## Development Notes

The current module id is `ARKS-Shop` so it matches the existing folder name in this Foundry data directory. Foundry's package guidance recommends a lowercase folder and id such as `arks-shop`; if you rename the folder later, update the manifest id and `MODULE_ID` constant to match exactly.

The manifest currently leaves `relationships.systems` empty until the target system id is confirmed:

```json
"relationships": {
  "systems": []
}
```

If this module should only run for a specific system, add that system relationship before release. In this Foundry data directory there is an installed `acks` system, so if that is your target the relationship would look like:

```json
"relationships": {
  "systems": [
    {
      "id": "acks",
      "type": "system"
    }
  ]
}
```
