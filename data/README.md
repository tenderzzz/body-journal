# 食材来源

`foods.json` 是 USDA FoodData Central SR Legacy（2018 年 4 月）CSV 快照的四项营养数据摘取：每 100 g 可食部的能量（kcal）、蛋白质、脂肪、碳水（g）。缺值保留为 null，不作为零。

数据为公有领域 / CC0；中文名称是搜索辅助翻译，不表示中国食堂菜品实测。必须区分原料、生熟、可食部、加工方式。混合菜由估计原料组成；油和食用量不明时保留不确定性。匹配不到的原料不计入已知小计。

- 官方下载：https://fdc.nal.usda.gov/download-datasets/
- 使用说明：https://fdc.nal.usda.gov/api-guide/
- 重建：`python3 scripts/build-foods.py /path/to/FoodData_Central_sr_legacy_food_csv_2018-04.zip`

快照元数据保存下载地址及原始压缩包 SHA-256，单项保存 FDC 编号及来源链接。模型只能引用给定目录内的编号，本地程序计算营养范围。
