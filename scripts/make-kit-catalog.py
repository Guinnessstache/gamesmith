"""Builds resources/kits/catalog.json from a `git ls-tree -r HEAD public/glb` listing of
trebeljahr/quaternius-showcase (all models CC0-1.0 by Quaternius; see its LICENSES.md).
    python3 scripts/make-kit-catalog.py <ls-tree.txt> <commit>
"""
import json, sys, collections

listing, commit = sys.argv[1], sys.argv[2]
# directory -> (id, name, what's in it, quaternius page)
PACKS = {
    "animals_pack": ("animals", "Animated Animals", "Farm and wild animals, rigged and animated", "ultimateanimatedanimals"),
    "buildings_pack_2": ("buildings", "Buildings", "Simple houses, shops and towers", "buildings"),
    "buildings_pack_3": ("buildings-textured", "Textured Buildings", "Town buildings with textures", "ultimatetexturedbuildings"),
    "crops_pack": ("crops", "Crops", "Plants and crops in growth stages", "ultimatecrops"),
    "cute_fish_pack": ("cute-fish", "Cute Fish", "Animated cartoon fish", "cutefish"),
    "cyberpunk_pack": ("cyberpunk", "Cyberpunk Game Kit", "Neon city props, characters and guns", "cyberpunkgamekit"),
    "dinosaurs_pack": ("dinosaurs", "Animated Dinosaurs", "Rigged, animated dinosaurs", "animateddinosaurs"),
    "easy_enemies_pack": ("enemies", "Easy Enemies", "Animated monsters for games", "easyenemy"),
    "fish_pack": ("fish", "Animated Fish", "Realistic-style animated fish", "animatedfish"),
    "house_interior_pack": ("house-interior", "House Interior", "Furniture, kitchen, bathroom and decor", "ultimatehomeinterior"),
    "mech_pack": ("mechs", "Animated Mechs", "Rigged, animated mechs", "animatedmech"),
    "medieval_village_pack": ("medieval-village", "Medieval Village", "Houses, walls, carts and village props", "medievalvillage"),
    "medieval_weapons_pack": ("medieval-weapons", "Medieval Weapons", "Swords, axes, shields and bows", "medievalweapons"),
    "modular_dungeon_1": ("dungeon", "Modular Dungeon", "Snap-together dungeon walls, floors and props", "modulardungeon"),
    "modular_dungeon_pack": ("dungeon-2", "Medieval Dungeon", "More dungeon pieces, doors and props", "medievaldungeon"),
    "modular_medieval_buildings_pack": ("medieval-buildings", "Modular Medieval Buildings", "Wall, roof and window pieces to build houses", "modularmedievalbuildings"),
    "modular_men": ("men", "Modular Men", "Rigged men in different outfits", "ultimatemodularcharacters"),
    "modular_sci_fi": ("sci-fi", "Modular Sci-Fi", "Space station walls, floors and props", "ultimatemodularscifi"),
    "modular_sci_fi_guns_pack": ("sci-fi-guns", "Sci-Fi Guns", "Modular sci-fi gun parts", "scifimodularguns"),
    "modular_women": ("women", "Modular Women", "Rigged women in different outfits", "ultimatemodularwomen"),
    "nature_pack": ("nature", "Nature", "Trees, rocks, bushes, flowers and grass", "ultimatenature"),
    "platformer_game_pack": ("platformer", "Platformer Game Kit", "Platforms, coins, hazards and characters", "ultimateplatformer"),
    "platformer_pack": ("platformer-modular", "Modular Platformer", "Blocks and pieces for platform levels", "modularplatformer"),
    "real_time_strategy_pack": ("fantasy-rts", "Fantasy RTS", "Castles, towers, units and resources", "ultimatefantasyrts"),
    "rpg_items_pack": ("rpg-items", "RPG Items", "Potions, chests, weapons, armor and loot", "ultimaterpg"),
    "ships_pack": ("ships", "Ships", "Sailing ships and boats", "ships"),
    "simple_nature_pack": ("simple-nature", "Simple Nature", "A few simple trees, rocks and plants", "simplenature"),
    "single_knight_pack": ("knight", "Animated Knight", "A rigged, animated knight", "knightcharacter"),
    "spaceships_pack": ("spaceships", "Spaceships", "Spaceships and fighters", "ultimatespaceships"),
    "street_pack": ("streets", "Modular Streets", "Roads, sidewalks, lights and signs", "modularstreets"),
    "survival_pack": ("survival", "Survival", "Tools, camp, food and crafting props", "survival"),
    "tank_pack": ("tanks", "Animated Tanks", "Rigged, animated tanks", "animatedtanks"),
    "ultimate_space_pack": ("space", "Space Kit", "Planets, bases, rovers and astronauts", "ultimatespacekit"),
}
files = collections.defaultdict(list)
for line in open(listing, encoding="utf-8"):
    meta, path = line.rstrip("\n").split("\t", 1)
    sha = meta.split()[2]
    parts = path.split("/")
    if len(parts) != 4 or not path.endswith(".glb"):
        continue
    files[parts[2]].append({"f": parts[3], "sha": sha})
packs = []
for d, (pid, name, about, page) in PACKS.items():
    fl = sorted(files[d], key=lambda x: x["f"].lower())
    assert fl, d
    packs.append({"id": pid, "name": name, "about": about, "source": "Quaternius", "url": f"https://quaternius.com/packs/{page}.html",
                  "license": "CC0", "dir": d, "files": fl})
missing = set(files) - set(PACKS)
assert not missing, missing
packs.sort(key=lambda p: p["name"])
out = {"version": 1, "base": f"https://raw.githubusercontent.com/trebeljahr/quaternius-showcase/{commit}/public/glb/",
       "credit": "Models by Quaternius (quaternius.com), CC0 1.0. Mirrored by github.com/trebeljahr/quaternius-showcase.", "packs": packs}
json.dump(out, open("resources/kits/catalog.json", "w"), separators=(",", ":"))
print(len(packs), "packs,", sum(len(p["files"]) for p in packs), "models")
