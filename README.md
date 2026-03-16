# ARKS Shop

ARKS Shop is a Foundry VTT module that turns selected item compendiums into an in-game storefront for the `acks` system. Players can browse available gear, buy directly onto owned characters, and use a separate split-cost tool to distribute shared expenses across the party.

## Features

- Builds a shop inventory from selected item compendiums.
- Filters inventory by compendium, item type, purchase availability, and text search.
- Lets players buy items directly onto owned `character` actors.
- Supports quantity purchases and per-item price previews.
- Offers masterwork variants for weapons, armor, and instrument-like items.
- Adds `Open Shop` and `Split Costs` buttons to the Item Directory footer.
- Registers a `Shift+S` keybinding to open the shop window.
- Posts chat messages for completed purchases and split-cost payments.

## Requirements

- Foundry Virtual Tabletop v13 or newer.
- Verified against Foundry v13.350.
- The `acks` game system must be active for the world.

The module relies on ACKS-style actor and item data, including:

- `character` actors with `getTotalMoneyGC()`.
- `money` items with `system.coppervalue` and `system.quantity`.
- shop item types `item`, `weapon`, and `armor`.

## Installation

1. Place this repository in your Foundry data directory under `Data/modules/ARKS-Shop`.
2. Start Foundry and enable `ARKS Shop` in your world.
3. Make sure the world is using the `acks` system.

## Configuration

On first load, the first GM to enter the world automatically selects all eligible equipment compendiums. A compendium is considered eligible when it contains `Item` documents and its collection or label matches terms such as `equipment`, `weapon`, `armor`, `clothing`, `gear`, or `money`.

To change the packs used by the shop:

1. Open `Configure Settings`.
2. Go to `Module Settings > ARKS Shop`.
3. Open `Equipment compendiums`.
4. Check the packs that should populate the shop.

There is also a client setting to show or hide the Item Directory footer buttons.

## Usage

### Shop

Open the shop from one of these entry points:

- the `Open Shop` button in the Item Directory
- the `Shift+S` keybinding
- `game.ARKSShop.openShop()`

Inside the shop window you can:

- choose the actor that will receive the purchase
- search by item or source compendium
- toggle compendium, type, and availability filters
- change quantity before purchase
- choose a masterwork option when one is available
- open the original compendium entry by clicking the item name

If the selected actor cannot afford the current total, the buy button is disabled.

### Split Costs

`Split Costs` is a separate utility for party expenses that do not create an item. Open it from the Item Directory footer or with `game.ARKSShop.openSplitCosts()`.

The form lets you:

- enter a total abstract cost
- choose which owned characters are paying
- assign manual contributions
- auto-fill the remaining amount with `Split Even`

Submission only succeeds when the assigned contributions exactly match the total and every selected actor can cover their share.

## Masterwork Behavior

Masterwork purchases duplicate the source item into the actor inventory with adjusted price data and a stored module flag describing the selected variant.

- Weapons can gain `+1 hit`, `+1 damage`, or both.
- Armor can gain `lighter by 1 stone` or `+1 AC`.
- Instrument-like `item` entries can be purchased with performance-themed masterwork labels and pricing.

For weapon and armor options, the module updates the copied item data where expected ACKS fields are present. Instrument variants currently change the purchased item's name, description, flags, and price, but do not apply an additional system-specific stat change.

## Money Handling

Purchases and split costs deduct funds from the actor's `money` items based on copper value. The module recalculates remaining coin quantities from highest denomination to lowest.

This means:

- the actor must have enough total money to pay
- the actor must be able to make exact change with carried denominations
- otherwise the purchase or split payment is rejected

## API

The module exposes a small API on `game.ARKSShop`:

```js
game.ARKSShop.openShop({ actorId });
game.ARKSShop.openSplitCosts({ totalCost, actorIds, contributions });
game.ARKSShop.getSelectedEquipmentPacks();
game.ARKSShop.refreshInventory();
```

## Notes

- Non-GM users can only buy for actors they own.
- Only visible compendiums are loaded for non-GM users.
- The shop inventory is cached and refreshed automatically when the selected compendium list changes.
- Item stacking is only applied to purchased `item` entries; `weapon` and `armor` purchases create separate embedded items.
