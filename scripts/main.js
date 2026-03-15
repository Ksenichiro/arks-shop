const MODULE_ID = "ARKS-Shop";
const EQUIPMENT_COMPENDIUM_SETTING = "selectedEquipmentCompendiums";
const EQUIPMENT_COMPENDIUMS_INITIALIZED_SETTING = "equipmentCompendiumsInitialized";
const EQUIPMENT_PACK_PATTERN = /(equipment|weapon|armor|clothing|gear|money)/i;
const SELLABLE_ITEM_TYPES = new Set(["item", "weapon", "armor"]);
const ITEM_DIRECTORY_ID = "items";

let shopApp;
let shopInventoryCache = [];
let shopInventoryCacheKey = "";

class ArksShopApp extends Application {
  constructor(options = {}) {
    super(options);
    this.selectedActorId = options.actorId ?? "";
    this.searchTerm = options.searchTerm ?? "";
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-app`,
      classes: [MODULE_ID.toLowerCase(), "arks-shop-app"],
      popOut: true,
      template: `modules/${MODULE_ID}/templates/shop-shell.hbs`,
      width: 960,
      height: 720,
      resizable: true,
      title: game.i18n.localize("ARKSSHOP.Title")
    });
  }

  async getData() {
    const characters = getAvailableCharacters();
    this.selectedActorId = getDefaultActorId(characters, this.selectedActorId);

    const selectedActor = characters.find((actor) => actor.id === this.selectedActorId) ?? null;
    const selectedActorGold = selectedActor ? selectedActor.getTotalMoneyGC() : 0;
    const selectedPackLabels = getSelectedPackLabels();
    const items = await getShopInventory();

    return {
      title: game.i18n.localize("ARKSSHOP.Title"),
      subtitle: game.i18n.localize("ARKSSHOP.Subtitle"),
      description: game.i18n.localize("ARKSSHOP.Description"),
      searchTerm: this.searchTerm,
      selectedPackCount: selectedPackLabels.length,
      selectedPackNames: selectedPackLabels.join(", ") || game.i18n.localize("ARKSSHOP.NoCompendiumsSelected"),
      hasCharacters: characters.length > 0,
      characters: characters.map((actor) => ({
        id: actor.id,
        name: actor.name,
        selected: actor.id === this.selectedActorId
      })),
      selectedActorGold: formatGp(selectedActorGold),
      hasItems: items.length > 0,
      items: items.map((item) => ({
        ...item,
        formattedPrice: formatGp(item.priceGp),
        canPurchase: selectedActor ? selectedActorGold >= item.priceGp : false
      }))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("select[name='actorId']").on("change", (event) => {
      this.selectedActorId = event.currentTarget.value;
      this.render(false);
    });

    html.find("input[name='search']").on("input", (event) => {
      this.searchTerm = event.currentTarget.value.trim().toLowerCase();
      this.#applySearchFilter(html);
    });

    html.find("[data-action='buy-item']").on("click", this.#onBuyItem.bind(this));
    html.find("[data-action='open-source']").on("click", this.#onOpenSource.bind(this));

    this.#applySearchFilter(html);
  }

  #applySearchFilter(html) {
    html.find(".arks-shop-item").each((_, element) => {
      const searchIndex = element.dataset.search ?? "";
      const matches = !this.searchTerm || searchIndex.includes(this.searchTerm);
      element.style.display = matches ? "" : "none";
    });
  }

  async #onOpenSource(event) {
    event.preventDefault();

    const itemUuid = event.currentTarget.closest("[data-item-uuid]")?.dataset.itemUuid;
    if (!itemUuid) return;

    const item = await fromUuid(itemUuid);
    item?.sheet?.render(true);
  }

  async #onBuyItem(event) {
    event.preventDefault();

    const row = event.currentTarget.closest("[data-item-uuid]");
    if (!row) return;

    const quantity = Math.max(1, Number.parseInt(row.querySelector("input[name='quantity']")?.value ?? "1", 10) || 1);

    try {
      await purchaseShopItem({
        actorId: this.selectedActorId,
        itemUuid: row.dataset.itemUuid,
        quantity
      });
      this.render(false);
    } catch (error) {
      console.error(`${MODULE_ID} | Purchase failed`, error);
      ui.notifications.error(error.message ?? game.i18n.localize("ARKSSHOP.Errors.PurchaseFailed"));
    }
  }
}

class ArksShopCompendiumSettingsForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-compendium-settings`,
      title: game.i18n.localize("ARKSSHOP.Settings.Compendiums.MenuLabel"),
      template: `modules/${MODULE_ID}/templates/settings-compendiums.hbs`,
      width: 520,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData() {
    const selected = new Set(game.settings.get(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING) ?? []);

    return {
      compendiums: getEligibleEquipmentPacks().map((pack) => ({
        fieldId: pack.collection.replaceAll(".", "__"),
        collection: pack.collection,
        label: pack.metadata.label,
        packageName: pack.metadata.packageName,
        checked: selected.has(pack.collection)
      }))
    };
  }

  async _updateObject(event) {
    const form = event.target;
    const selected = Array.from(form.querySelectorAll("input[name='compendiums']:checked"))
      .map((input) => input.value)
      .sort();

    await game.settings.set(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING, selected);
  }
}

function isEligibleEquipmentPack(pack) {
  if (pack.documentName !== "Item") return false;

  const metadataFields = [pack.collection, pack.metadata.label, pack.metadata.name];
  return metadataFields.some((value) => EQUIPMENT_PACK_PATTERN.test(value ?? ""));
}

function getEligibleEquipmentPacks() {
  return game.packs.contents
    .filter(isEligibleEquipmentPack)
    .sort((a, b) => a.metadata.label.localeCompare(b.metadata.label));
}

function getSelectedEquipmentPackIds() {
  const selected = game.settings.get(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING) ?? [];
  const validIds = new Set(getEligibleEquipmentPacks().map((pack) => pack.collection));
  return selected.filter((collection) => validIds.has(collection));
}

function getSelectedEquipmentPacks() {
  const selected = new Set(getSelectedEquipmentPackIds());
  return getEligibleEquipmentPacks().filter((pack) => selected.has(pack.collection));
}

function getSelectedPackLabels() {
  return getSelectedEquipmentPacks().map((pack) => pack.metadata.label);
}

function getAvailableCharacters() {
  const characters = game.actors.contents
    .filter((actor) => actor.type === "character" && (game.user.isGM || actor.isOwner))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (game.user.character?.type === "character") {
    characters.sort((left, right) => {
      if (left.id === game.user.character.id) return -1;
      if (right.id === game.user.character.id) return 1;
      return left.name.localeCompare(right.name);
    });
  }

  return characters;
}

function getDefaultActorId(characters, preferredActorId) {
  if (characters.some((actor) => actor.id === preferredActorId)) return preferredActorId;
  if (game.user.character && characters.some((actor) => actor.id === game.user.character.id)) return game.user.character.id;
  return characters[0]?.id ?? "";
}

function getTypeLabel(type) {
  const label = game.i18n.localize(`ARKSSHOP.ItemTypes.${type}`);
  return label.startsWith("ARKSSHOP.") ? type : label;
}

function getItemCost(item) {
  const cost = Number(item.system?.cost ?? 0);
  return Number.isFinite(cost) ? cost : 0;
}

function formatGp(value) {
  const rounded = (Math.round(Number(value) * 100) / 100).toFixed(2);
  return rounded.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function gpToCopper(value) {
  return Math.round(Number(value) * 100);
}

function getMoneyItems(actor) {
  return actor.items
    .filter((item) => item.type === "money" && Number(item.system.coppervalue) > 0)
    .sort((a, b) => Number(b.system.coppervalue) - Number(a.system.coppervalue));
}

function resetShopInventoryCache() {
  shopInventoryCache = [];
  shopInventoryCacheKey = "";

  if (shopApp?.rendered) {
    shopApp.render(false);
  }
}

async function ensureDefaultEquipmentCompendiums() {
  if (!game.user.isGM) return;
  if (game.settings.get(MODULE_ID, EQUIPMENT_COMPENDIUMS_INITIALIZED_SETTING)) return;

  const defaults = getEligibleEquipmentPacks().map((pack) => pack.collection);
  await game.settings.set(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING, defaults);
  await game.settings.set(MODULE_ID, EQUIPMENT_COMPENDIUMS_INITIALIZED_SETTING, true);
}

async function getShopInventory() {
  const selectedPackIds = getSelectedEquipmentPackIds();
  const cacheKey = selectedPackIds.join("|");

  if (cacheKey === shopInventoryCacheKey) {
    return shopInventoryCache;
  }

  const inventory = [];

  for (const collection of selectedPackIds) {
    const pack = game.packs.get(collection);
    if (!pack) continue;
    if (!game.user.isGM && pack.visible === false) continue;

    try {
      const documents = await pack.getDocuments();

      for (const document of documents) {
        if (!SELLABLE_ITEM_TYPES.has(document.type)) continue;

        inventory.push({
          uuid: document.uuid,
          name: document.name,
          img: document.img,
          type: document.type,
          typeLabel: getTypeLabel(document.type),
          sourceLabel: pack.metadata.label,
          priceGp: getItemCost(document),
          searchText: `${document.name} ${pack.metadata.label} ${document.type}`.toLowerCase()
        });
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to load shop compendium ${collection}`, error);
    }
  }

  inventory.sort((left, right) => {
    if (left.type !== right.type) return left.type.localeCompare(right.type);
    return left.name.localeCompare(right.name);
  });

  shopInventoryCache = inventory;
  shopInventoryCacheKey = cacheKey;

  return inventory;
}

function prepareOwnedItemData(sourceItem) {
  const itemData = foundry.utils.deepClone(sourceItem.toObject());

  delete itemData._id;
  delete itemData.folder;
  delete itemData.pack;
  delete itemData.sort;

  if (itemData.system?.hasOwnProperty("equipped")) itemData.system.equipped = false;
  if (itemData.system?.hasOwnProperty("favorite")) itemData.system.favorite = false;
  if (itemData.system?.quantity?.value != null) itemData.system.quantity.value = 1;

  return itemData;
}

async function deductActorMoney(actor, totalPriceGp) {
  const costInCopper = gpToCopper(totalPriceGp);
  if (costInCopper <= 0) return;

  const moneyItems = getMoneyItems(actor);
  let remainingCopper = moneyItems.reduce(
    (total, item) => total + Number(item.system.quantity ?? 0) * Number(item.system.coppervalue ?? 0),
    0
  );

  if (remainingCopper < costInCopper) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.NotEnoughGold"));
  }

  remainingCopper -= costInCopper;

  const updates = [];
  for (const moneyItem of moneyItems) {
    const coinValue = Number(moneyItem.system.coppervalue);
    const newQuantity = Math.floor(remainingCopper / coinValue);
    remainingCopper -= newQuantity * coinValue;

    if (newQuantity !== Number(moneyItem.system.quantity)) {
      updates.push({
        _id: moneyItem.id,
        "system.quantity": newQuantity
      });
    }
  }

  if (remainingCopper > 0) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.CannotMakeChange"));
  }

  if (updates.length) {
    await actor.updateEmbeddedDocuments("Item", updates);
  }
}

async function addPurchasedItems(actor, shopItem, quantity) {
  if (shopItem.type === "item") {
    const existing = actor.items.find(
      (item) =>
        item.type === "item" &&
        item.name === shopItem.name &&
        (item.system.subtype ?? "") === (shopItem.system.subtype ?? "")
    );

    if (existing) {
      const currentQuantity = Number(existing.system.quantity?.value ?? 1);
      await existing.update({ "system.quantity.value": currentQuantity + quantity });
      return;
    }
  }

  const itemData = Array.from({ length: quantity }, () => prepareOwnedItemData(shopItem));

  if (shopItem.type === "item") {
    itemData[0].system.quantity.value = quantity;
    await actor.createEmbeddedDocuments("Item", [itemData[0]]);
    return;
  }

  await actor.createEmbeddedDocuments("Item", itemData);
}

async function createPurchaseChatMessage(actor, item, quantity, totalPriceGp) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: game.i18n.format("ARKSSHOP.Messages.Purchase", {
      actor: actor.name,
      quantity,
      item: item.name,
      cost: formatGp(totalPriceGp)
    })
  });
}

async function purchaseShopItem({ actorId, itemUuid, quantity }) {
  const actor = game.actors.get(actorId);
  if (!actorId || !actor || actor.type !== "character" || (!game.user.isGM && !actor.isOwner)) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.NoCharacter"));
  }

  const shopItem = await fromUuid(itemUuid);
  if (!(shopItem instanceof Item) || !SELLABLE_ITEM_TYPES.has(shopItem.type)) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.InvalidItem"));
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.InvalidQuantity"));
  }

  const totalPriceGp = getItemCost(shopItem) * quantity;
  if (actor.getTotalMoneyGC() < totalPriceGp) {
    throw new Error(
      game.i18n.format("ARKSSHOP.Errors.NotEnoughGoldForItem", {
        actor: actor.name,
        quantity,
        item: shopItem.name,
        cost: formatGp(totalPriceGp)
      })
    );
  }

  await deductActorMoney(actor, totalPriceGp);
  await addPurchasedItems(actor, shopItem, quantity);
  await createPurchaseChatMessage(actor, shopItem, quantity, totalPriceGp);

  ui.notifications.info(
    game.i18n.format("ARKSSHOP.Messages.PurchaseNotice", {
      actor: actor.name,
      quantity,
      item: shopItem.name,
      cost: formatGp(totalPriceGp)
    })
  );
}

function registerSettings() {
  game.settings.register(MODULE_ID, "showActorsDirectoryButton", {
    name: "ARKSSHOP.Settings.ShowButton.Name",
    hint: "ARKSSHOP.Settings.ShowButton.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.registerMenu(MODULE_ID, "equipmentCompendiumsMenu", {
    name: "ARKSSHOP.Settings.Compendiums.MenuLabel",
    label: "ARKSSHOP.Settings.Compendiums.MenuButton",
    hint: "ARKSSHOP.Settings.Compendiums.MenuHint",
    icon: "fas fa-book",
    type: ArksShopCompendiumSettingsForm,
    restricted: true
  });

  game.settings.register(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING, {
    name: "ARKSSHOP.Settings.Compendiums.Name",
    hint: "ARKSSHOP.Settings.Compendiums.Hint",
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: resetShopInventoryCache
  });

  game.settings.register(MODULE_ID, EQUIPMENT_COMPENDIUMS_INITIALIZED_SETTING, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });
}

function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "openShop", {
    name: "ARKSSHOP.Keybindings.OpenShop.Name",
    hint: "ARKSSHOP.Keybindings.OpenShop.Hint",
    editable: [
      {
        key: "KeyS",
        modifiers: ["Shift"]
      }
    ],
    onDown: () => {
      game.ARKSShop.openShop();
      return true;
    },
    restricted: false
  });
}

function createApi() {
  return {
    openShop: (options = {}) => {
      if (!shopApp) {
        shopApp = new ArksShopApp(options);
      } else if (options.actorId) {
        shopApp.selectedActorId = options.actorId;
      }

      shopApp.render(true);
      return shopApp;
    },
    getSelectedEquipmentPacks,
    refreshInventory: resetShopInventoryCache
  };
}

function getRootElement(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  return html[0] ?? null;
}

function ensureDirectoryFooter(root) {
  let footer = root.querySelector(".directory-footer");
  if (footer) return footer;

  footer = document.createElement("footer");
  footer.className = "directory-footer action-buttons flexrow";

  const directoryList = root.querySelector(".directory-list");
  if (directoryList?.parentElement) {
    directoryList.insertAdjacentElement("afterend", footer);
  } else {
    root.appendChild(footer);
  }

  return footer;
}

function addDirectoryButton(app, html) {
  const isItemDirectory =
    app?.options?.id === ITEM_DIRECTORY_ID ||
    app?.documentName === "Item" ||
    app?.constructor?.name === "ItemDirectory";

  if (!isItemDirectory) return;
  if (!game.settings.get(MODULE_ID, "showActorsDirectoryButton")) return;

  const root = getRootElement(html);
  if (!root || root.querySelector(`.${MODULE_ID}-open-shop`)) return;

  const footer = ensureDirectoryFooter(root);

  const button = document.createElement("button");
  button.type = "button";
  button.className = `${MODULE_ID}-open-shop`;
  button.innerHTML = `<i class="fas fa-store"></i> ${game.i18n.localize("ARKSSHOP.OpenShop")}`;

  button.addEventListener("click", () => game.ARKSShop.openShop());
  footer.appendChild(button);
}

Hooks.once("init", async () => {
  console.log(`${MODULE_ID} | Initializing module`);
  registerSettings();
  registerKeybindings();
  game.ARKSShop = createApi();

  await loadTemplates([
    `modules/${MODULE_ID}/templates/shop-shell.hbs`,
    `modules/${MODULE_ID}/templates/settings-compendiums.hbs`
  ]);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
  void ensureDefaultEquipmentCompendiums().then(() => resetShopInventoryCache());
});

Hooks.on("renderSidebarTab", (app, html) => {
  addDirectoryButton(app, html);
});

Hooks.on("renderItemDirectory", (app, html) => {
  addDirectoryButton(app, html);
});
