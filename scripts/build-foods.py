"""Create the offline four-nutrient snapshot from the unmodified USDA SR Legacy CSV archive."""
import csv
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

archive = Path(sys.argv[1])
out = Path(__file__).resolve().parents[1] / 'data' / 'foods.json'
aliases = {
    168878: '白米饭（熟）', 168919: '鸡蛋面（煮熟，含盐）', 168914: '米粉（煮熟）',
    167532: '白小麦面包', 169705: '燕麦（干）', 173424: '水煮鸡蛋', 173423: '煎鸡蛋',
    172187: '炒鸡蛋', 172475: '硬豆腐（生，石膏凝固）', 172476: '普通豆腐（生，石膏凝固）',
    171477: '去皮鸡胸肉（烤熟）', 171478: '去皮鸡胸肉（炖熟）',
    167905: '猪里脊（含脂肪，烤熟）', 168634: '瘦牛上腰肉（烤熟）',
    175168: '养殖三文鱼（熟）', 175180: '虾（熟）',
    171411: '大豆油', 171413: '橄榄油', 169655: '白砂糖',
    169967: '西兰花（水煮，无盐）', 168463: '菠菜（水煮，无盐）',
    168517: '小白菜（水煮，含盐）', 169976: '卷心菜（水煮，无盐）',
    170050: '番茄（熟）', 168409: '黄瓜（带皮，生）', 170394: '胡萝卜（水煮，无盐）',
    169252: '白蘑菇（水煮，无盐）', 170440: '土豆（水煮，去皮，无盐）',
    168484: '红薯（水煮，去皮）', 173944: '香蕉（生）', 167793: '富士苹果（带皮）',
    169097: '橙子', 173806: '花生（干烤，无盐）', 171265: '全脂牛奶（3.25% 脂肪）',
    171284: '原味全脂酸奶', 170886: '原味低脂酸奶', 172446: '豆奶（原味或香草味，未强化）',
    172421: '扁豆（水煮，无盐）'
}
with zipfile.ZipFile(archive) as z:
    def rows(name):
        member = next(n for n in z.namelist() if n.endswith('/' + name))
        return csv.DictReader(io.TextIOWrapper(z.open(member), encoding='utf-8-sig'))
    nutrients = {1008:'kcal', 1003:'protein', 1004:'fat', 1005:'carbs'}
    values = {}
    for r in rows('food_nutrient.csv'):
        key = nutrients.get(int(r['nutrient_id']))
        if key and r['amount']:
            values.setdefault(int(r['fdc_id']), {})[key] = float(r['amount'])
    foods = []
    for r in rows('food.csv'):
        food_id = int(r['fdc_id'])
        v = values.get(food_id, {})
        f = dict(id=food_id, description=r['description'], source=f'https://fdc.nal.usda.gov/food-details/{food_id}/nutrients', **{k:v.get(k) for k in nutrients.values()})
        if food_id in aliases:
            f['zh'] = aliases[food_id]
        foods.append(f)
    assert all(any(f['id'] == i for f in foods) for i in aliases)
    assert len(foods) > 7000
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(dict(dataset='USDA FoodData Central SR Legacy April 2018', units='per 100 g edible portion; kcal and g', license='Public domain / CC0', source='https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip', archiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest(), foods=foods), ensure_ascii=False, separators=(',',':')))
print(f'{len(foods)} foods; {len(aliases)} Chinese search labels; {out.stat().st_size} bytes')
