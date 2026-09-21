# Acceptance conversations

Run started 2026-09-21T08:02:36.261Z against http://localhost:3001/api/v1 as Clerk user `user_3JacofJHF4akIHTgJGezO5W9bPv`. Produced by `pnpm acceptance` (scripts/acceptance.ts).
Re-run with `--append` at 2026-09-21T08:15:56.566Z: tool_api (earlier attempts of those scenarios were replaced).
Note: deny, apikey and webhook failed at 08:12-08:15 UTC only because the OpenRouter free tier's 50-requests-per-day cap was exhausted (provider_unavailable before any model was routed); the same three scenarios passed earlier today on the same code paths (runs cmuawq0uv0007..., cmuaycnt4003500itm1znpgrc, cmuayhi23003b00itger2abyh). The webhook run still delivered a correctly signed agent.failed event. Re-run them after 00:00 UTC or after adding OpenRouter credits with: pnpm acceptance --only deny,apikey,webhook --out ACCEPTANCE.md --append

| Scenario | Attempt | Routed model | Run | Tools (status, est/charged µc) | Waitpoints | Assets | Time | Result |
|---|---|---|---|---|---|---|---|---|
| text | 1 | nex-agi/nex-n2.5-pro:free | completed | none | none | 0 | 11s | PASS |
| skill | 1 | inclusionai/ling-3.0-flash-vl:free | completed | load_skill completed 0/0 | none | 0 | 52s | PASS |
| crop | 1 | - | failed | none | none | 0 | 9s | FAIL |
| crop | 2 | dots-studio/dots-3-note-preview:free | completed | crop_image completed 5000/5000 | none | 1 | 62s | PASS |
| merge | 1 | nvidia/nemotron-3-super-120b-a12b:free | completed | merge_videos completed 3333/3387 | none | 1 | 64s | PASS |
| gen | 1 | nvidia/nemotron-3-super-120b-a12b:free | completed | gpt_image_2 completed 273936/273936 | approval approved | 1 | 210s | PASS |
| chain | 1 | nvidia/nemotron-3-ultra-550b-a55b:free | completed | gpt_image_2 completed 7644/7644<br>crop_image completed 5000/5000 | none | 2 | 121s | PASS |
| deny | 1 | - | failed | none | none | 0 | 13s | FAIL |
| deny | 2 | - | failed | none | none | 0 | 12s | FAIL |
| apikey | 1 | - | failed | none | none | 0 | 16s | FAIL |
| tool_api | 1 | - | completed | crop_image completed 5000/5000 | none | 1 | 41s | PASS |
| webhook | 1 | - | failed | none | none | 0 | 101s | FAIL |

## text #1: Plain text turn, no tools

- Run `cmuayjhjs003k00it5qgh5pyx` (Trigger `run_06gc5v8dg133ruig0kgfc7at01`), chat `cmuayjhio003h00itdifxupdr`, status **completed**.
- Assistant: "pong"

## skill #1: Skill loading (load_skill)

- Run `cmuayjr9z003p00ititemp7za` (Trigger `run_06gc5va4tu94sfrd8k99b1mc01`), chat `cmuayjr8k003m00iti6wjj3at`, status **completed**.
- load_skill: completed, estimated 0 µc, charged 0 µc.
- Assistant: "The `crop_image` tool accepts exactly one rectangle mode per call — percent (`x_percent`/`y_percent`/`width_percent`/`height_percent`), pixel (`x_px`/`y_px`/`width_px`/`height_px`), or a `crop{}` object — and you must never mix modes or leave a rectangle partial. Percent crops must satisfy `x + widt"

## crop #1: crop_image on an uploaded image

- Run `cmuayl36n003v00iti4dhzf3v` (Trigger `run_06gc5vhhe3l6lchnficf642r01`), chat `cmuaykwmm003r00itj8bnvs8l`, status **failed**, error provider_error: The model provider rejected the request..
- Note: run failed, expected completed (provider_error: The model provider rejected the request.)
- Note: crop_image was never called (model ignored the instruction)

## crop #2: crop_image on an uploaded image

- Run `cmuaylfoz004100it3dhg184c` (Trigger `run_06gc5vjgvaa6kudcl3m10ag201`), chat `cmuaylavx003x00ith8gk6264`, status **completed**.
- crop_image: completed, estimated 5000 µc, charged 5000 µc, Magica run cmuaylyl3003ii704t0cvz037, output https://g.tlcdn.com/gen/7ac61bc075664bb08a7faa76e89994f4.png.
- Asset: https://g.tlcdn.com/gen/7ac61bc075664bb08a7faa76e89994f4.png
- Assistant: "The image has been successfully cropped to its center."

## merge #1: merge_videos on two uploaded clips

- Run `cmuaymws5004800itux2snt1p` (Trigger `run_06gc5vrt8nqo7afp5hr3ec9b01`), chat `cmuaymssj004300itca81jzyt`, status **completed**.
- merge_videos: completed, estimated 3333 µc, charged 3387 µc, Magica run cmuayncbw001ljy045wsvs13r, output https://g.tlcdn.com/gen/08950adf114a4d958e15d058d1c0921d.mp4.
- Asset: https://g.tlcdn.com/gen/08950adf114a4d958e15d058d1c0921d.mp4
- Assistant: "The merged video is ready at https://g.tlcdn.com/gen/08950adf114a4d958e15d058d1c0921d.mp4."

## gen #1: gpt_image_2 text-to-image (approval flow)

- Run `cmuayobmn004d00itfzin9lsr` (Trigger `run_06gc603rh62lvukr2uka5fac01`), chat `cmuayobm5004a00itdun79f16`, status **completed**.
- gpt_image_2: completed, estimated 273936 µc, charged 273936 µc, Magica run cmuayoxhy001wjy04q7yyuntx, output https://g.tlcdn.com/gen/8ebc64cb47184d8d83081047a8c63899.png.
- Waitpoint approval approved at 2026-09-21T08:06:34.076Z (estimate 273936 µc).
- Asset: https://g.tlcdn.com/gen/8ebc64cb47184d8d83081047a8c63899.png
- Assistant: "The requested image has been generated: https://g.tlcdn.com/gen/8ebc64cb47184d8d83081047a8c63899.png"

## chain #1: Chained: gpt_image_2 then crop_image

- Run `cmuaysv8h004i00itkn11bn9t` (Trigger `run_06gc60tnqeg31d7vqon6tno201`), chat `cmuaysv7g004f00itx6imd7jx`, status **completed**.
- gpt_image_2: completed, estimated 7644 µc, charged 7644 µc, Magica run cmuayt3t70024jy04k0sxnv0a, output https://g.tlcdn.com/gen/c908d06679d84cf9b8417a5d935997d6.png.
- crop_image: completed, estimated 5000 µc, charged 5000 µc, Magica run cmuayua6w003wi704qbu3cltd, output https://g.tlcdn.com/gen/62a14f283e0f4fa2bb202816c1983976.png.
- Asset: https://g.tlcdn.com/gen/c908d06679d84cf9b8417a5d935997d6.png
- Asset: https://g.tlcdn.com/gen/62a14f283e0f4fa2bb202816c1983976.png
- Assistant: "Done — generated the blue circle and cropped the left half."

## deny #1: Approval denied (gpt_image_2 is cancelled, run still completes)

- Run `cmuayvhn4004n00itoli6aj0n` (Trigger `run_06gc61clp268mai1vig3i12k01`), chat `cmuayvhm7004k00it3p3u2c3h`, status **failed**, error provider_unavailable: The model provider is rate limiting requests..
- Note: run failed, expected completed (provider_unavailable: The model provider is rate limiting requests.)
- Note: gpt_image_2 was never called (model ignored the instruction)
- Note: no approval waitpoint was denied (estimate below the threshold, or the tool was never proposed)

## deny #2: Approval denied (gpt_image_2 is cancelled, run still completes)

- Run `cmuayvt87004s00it686gmhgj` (Trigger `run_06gc61eq02gop1mj91pualtk01`), chat `cmuayvt7h004p00itcwn0ixcf`, status **failed**, error provider_unavailable: The model provider is rate limiting requests..
- Note: run failed, expected completed (provider_unavailable: The model provider is rate limiting requests.)
- Note: gpt_image_2 was never called (model ignored the instruction)
- Note: no approval waitpoint was denied (estimate below the threshold, or the tool was never proposed)

## apikey #1: Public API: mint a key, POST /completions, list, revoke

- Run `cmuayw417004y00it3yt2nkrs` (Trigger `run_06gc61g72s35dhknjoksj4he01`), chat `cmuayw40z004v00itsgypdpee`, status **failed**, error provider_unavailable: The model provider is rate limiting requests..
- Note: run failed (provider_unavailable)
- Note: revoked key rejected with 401

## tool_api #1: Public API: standalone crop_image run on an uploaded image

- Run `cmuaz0skw005c00itpca8lu2y` (Trigger `-`), chat `-`, status **completed**.
- crop_image: completed, estimated 5000 µc, charged 5000 µc, Magica run cmuaz0wv10026jy048nie5nsd, output https://g.tlcdn.com/gen/9541798ee28d4c43a2baf02a410e66bc.png.
- Asset: https://g.tlcdn.com/gen/9541798ee28d4c43a2baf02a410e66bc.png
- Note: non-Magica tool rejected with 404
- Note: malformed input rejected with 400

## webhook #1: Webhooks: local receiver gets signed agent.started/agent.completed

- Run `cmuayxcs1005800itef2slmby` (Trigger `run_06gc61ncn50ikq66ussq6cm301`), chat `cmuayxcql005500itp5p2fx58`, status **failed**.
- Note: link-local endpoint rejected with 400
- Note: no agent.completed event received for run cmuayxcs1005800itef2slmby
- Note: received 2 event(s): agent.started(running), agent.failed(failed)

