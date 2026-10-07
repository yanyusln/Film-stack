import struct

src = r"e:\P\Film-stack\test_real.avi"
out = r"e:\P\Film-stack\test_placeholder.avi"

with open(src, "rb") as f:
    data = f.read()

assert data[:4] == b"RIFF"
body = bytearray(data[8:])  # 含 'AVI ' 起的整个 body

# 1) 剥掉 idx1 索引：块内插入 8 字节后索引全部错位（影栈直接走 movi 不读索引，但
#    ffprobe 会用），剥掉后两边都干净
i = body.find(b"idx1")
had_idx1 = i >= 0
if had_idx1:
    sz = struct.unpack("<I", body[i + 4:i + 8])[0]
    end = i + 8 + sz + (sz & 1)
    del body[i:end]

# 2) 定位 movi LIST：'LIST'@idx-8, size@idx-4, 'movi'@idx
idx = body.find(b"movi")
assert idx >= 0, "no movi"
assert bytes(body[idx - 8:idx - 4]) == b"LIST", "movi LIST header mismatch"
movi_size_off = idx - 4

# 3) 在 movi 内第一个 00dc 块之后插入 size==0 占位块
p = body.find(b"00dc", idx + 4)
assert p >= 0, "no 00dc"
csz = struct.unpack("<I", body[p + 4:p + 8])[0]
chunk_end = p + 8 + csz + (csz & 1)
placeholder = b"00dc" + struct.pack("<I", 0)
body[chunk_end:chunk_end] = placeholder

# 4) 更新 movi size
old = struct.unpack("<I", body[movi_size_off:movi_size_off + 4])[0]
body[movi_size_off:movi_size_off + 4] = struct.pack("<I", old + len(placeholder))

# 5) 重建：RIFF size = len(body)
new_data = data[:4] + struct.pack("<I", len(body)) + bytes(body)
with open(out, "wb") as f:
    f.write(new_data)

print(f"wrote {out}: {len(new_data)} bytes, placeholder after 00dc@{p}, idx1_stripped={had_idx1}")
