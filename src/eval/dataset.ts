import type { EvalGrounding } from './grounding'

export interface EvalExpect {
  type: 'reply' | 'tool'
  tool?: string
  safety?: 'read' | 'control'
}

export interface EvalCase {
  id: string
  message: string
  expect: EvalExpect
  /**
   * Optional grounding expectations for the reply TEXT (reply cases only). To keep
   * the grounding metric honest, do NOT put these on cases whose wording is
   * verbatim in the few-shot (e.g. the "vàng lá" case = few-shot Ví dụ 1) — the
   * model would score by copying, not by grounding.
   */
  grounding?: EvalGrounding
  /**
   * Chunk-id prefixes the retriever should surface for this message, e.g.
   * `strawberry:fertilizer` (profile field) or `disease:botrytis-gray-mold`.
   * Drives the recall@k and score-distribution report.
   */
  expectChunks?: string[]
  note?: string
}

/**
 * Vietnamese evaluation set (strawberry context) for measuring the small model's
 * first-decision tool selection. Grows over time; keep expectations deterministic.
 */
export const EVAL_CASES: EvalCase[] = [
  { id: 'sensor-moisture', message: 'Độ ẩm đất của thiết bị esp32-01 bao nhiêu?', expect: { type: 'tool', tool: 'get_latest_sensor', safety: 'read' } },
  { id: 'list-devices', message: 'Liệt kê các thiết bị đang có.', expect: { type: 'tool', tool: 'list_devices', safety: 'read' } },
  { id: 'sensor-history', message: 'Cho xem lịch sử cảm biến 24 giờ qua của esp32-01.', expect: { type: 'tool', tool: 'get_sensor_history', safety: 'read' } },
  { id: 'pending-cmds', message: 'Thiết bị esp32-01 đang có lệnh nào chờ chạy không?', expect: { type: 'tool', tool: 'get_recent_commands', safety: 'read' } },
  { id: 'water-10s', message: 'Tưới nước cho esp32-01 trong 10 giây.', expect: { type: 'tool', tool: 'set_pump', safety: 'control' } },
  { id: 'light-on', message: 'Bật đèn cho thiết bị esp32-01.', expect: { type: 'tool', tool: 'set_light', safety: 'control' } },
  { id: 'auto-water', message: 'Bật chế độ tưới tự động cho esp32-01.', expect: { type: 'tool', tool: 'set_mode', safety: 'control' } },
  { id: 'set-moisture-rule', message: 'Đặt luật tưới cho esp32-01 khi độ ẩm đất dưới 75%.', expect: { type: 'tool', tool: 'set_device_config', safety: 'control' } },
  { id: 'kb-temp', message: 'Cây dâu tây thích hợp nhiệt độ khoảng bao nhiêu?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['10', '27'] } },
  { id: 'kb-pests', message: 'Cây dâu hay bị sâu bệnh gì?', expect: { type: 'reply' }, expectChunks: ['strawberry:pests'] },
  { id: 'kb-moisture', message: 'Độ ẩm đất tối ưu cho dâu là bao nhiêu phần trăm?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['75', '80'], forbid: ['30%'] }, expectChunks: ['strawberry:watering'] },

  // --- A1: tools not previously covered ---
  { id: 'device-info', message: 'Cho xem thông tin chi tiết thiết bị esp32-01.', expect: { type: 'tool', tool: 'get_device_info', safety: 'read' } },
  { id: 'get-moisture-rule', message: 'Luật tưới theo độ ẩm của esp32-01 đang đặt thế nào?', expect: { type: 'tool', tool: 'get_device_config', safety: 'read' } },
  { id: 'get-light-rule', message: 'Xem luật chiếu sáng hiện tại của esp32-01.', expect: { type: 'tool', tool: 'get_device_config', safety: 'read' } },
  { id: 'auto-light', message: 'Bật đèn tự động cho esp32-01 khi trời tối.', expect: { type: 'tool', tool: 'set_mode', safety: 'control' } },
  { id: 'set-light-rule', message: 'Đặt luật bật đèn khi ánh sáng dưới 300 lux cho esp32-01.', expect: { type: 'tool', tool: 'set_device_config', safety: 'control' } },
  { id: 'show-message', message: 'Hiển thị dòng chữ "Chào mừng" lên màn hình thiết bị esp32-01.', expect: { type: 'tool', tool: 'show_message', safety: 'control' } },
  { id: 'refresh-config', message: 'Yêu cầu esp32-01 nạp lại cấu hình mới nhất.', expect: { type: 'tool', tool: 'refresh_device_config', safety: 'control' } },

  // --- A2: phrasing variants of already-covered tools ---
  { id: 'sensor-temp', message: 'Nhiệt độ hiện tại của esp32-01 là bao nhiêu?', expect: { type: 'tool', tool: 'get_latest_sensor', safety: 'read' } },
  { id: 'list-devices-alt', message: 'Có những thiết bị nào đang kết nối?', expect: { type: 'tool', tool: 'list_devices', safety: 'read' } },
  { id: 'sensor-history-12h', message: 'Cho xem số liệu độ ẩm 12 giờ qua của esp32-01.', expect: { type: 'tool', tool: 'get_sensor_history', safety: 'read' } },
  { id: 'pending-alt', message: 'esp32-01 còn lệnh nào chưa chạy không?', expect: { type: 'tool', tool: 'get_recent_commands', safety: 'read' } },
  { id: 'light-off', message: 'Tắt đèn thiết bị esp32-01.', expect: { type: 'tool', tool: 'set_light', safety: 'control' } },
  { id: 'water-15s', message: 'Mở nước tưới esp32-01 trong 15 giây.', expect: { type: 'tool', tool: 'set_pump', safety: 'control' } },

  // --- A3: knowledge questions that should stay a reply (drives RAG) ---
  { id: 'kb-fertilizer', message: 'Nên bón phân gì cho dâu khi cây ra hoa?', expect: { type: 'reply' }, grounding: { requireCitation: true }, expectChunks: ['strawberry:fertilizer'] },
  { id: 'kb-botrytis', message: 'Dâu bị mốc xám (nấm Botrytis) thì xử lý sao?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['mốc xám', 'botrytis'] }, expectChunks: ['disease:botrytis-gray-mold'] },
  { id: 'kb-harvest', message: 'Khi nào thì thu hoạch dâu được?', expect: { type: 'reply' }, expectChunks: ['strawberry:harvest'] },
  { id: 'kb-propagation', message: 'Dâu tây nhân giống bằng cách nào?', expect: { type: 'reply' }, expectChunks: ['strawberry:propagation'] },
  { id: 'kb-planting', message: 'Trồng dâu nên để khoảng cách cây bao nhiêu?', expect: { type: 'reply' }, grounding: { requireCitation: true }, expectChunks: ['strawberry:planting'] },
  { id: 'kb-toxicity', message: 'Chó ăn phải lá dâu có sao không?', expect: { type: 'reply' }, expectChunks: ['strawberry:toxicity'] },
  { id: 'kb-light-hours', message: 'Dâu tây cần mấy giờ nắng mỗi ngày?', expect: { type: 'reply' }, expectChunks: ['strawberry:light_description'] },
  { id: 'kb-ph', message: 'Đất trồng dâu nên có pH khoảng bao nhiêu?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['5.5', '6.5'] } },

  // --- A4: trap / chit-chat that should stay a reply (guards against over-triggering tools) ---
  { id: 'chat-hello', message: 'Xin chào!', expect: { type: 'reply' }, note: 'no tool' },
  { id: 'chat-thanks', message: 'Cảm ơn bạn nhiều nhé.', expect: { type: 'reply' }, note: 'no tool' },
  { id: 'chat-name', message: 'Bạn tên gì thế?', expect: { type: 'reply' }, note: 'no tool' },
  { id: 'chat-weather', message: 'Hôm nay trời đẹp nhỉ.', expect: { type: 'reply' }, note: 'no tool' },

  // --- A5: symptom / plant-health questions → reply from knowledge, no sensor fetch ---
  { id: 'symptom-yellow-leaves', message: 'Cây dâu của mình bị vàng lá, mình nên làm gì?', expect: { type: 'reply' }, note: 'advise from knowledge, no sensor' },
  { id: 'symptom-wilting', message: 'Dâu tây bị héo rũ thì xử lý sao?', expect: { type: 'reply' }, note: 'advise from knowledge, no sensor' },
  { id: 'symptom-leaf-spot', message: 'Lá dâu xuất hiện đốm nâu là bị gì?', expect: { type: 'reply' }, note: 'advise from knowledge, no sensor' },

  // --- A6: specific disease diagnosis (disease KB) + uses (databank) — all reply ---
  { id: 'diag-gray-mold', message: 'Quả dâu bị thối mềm, có lớp mốc xám phủ lên là bệnh gì?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['mốc xám', 'botrytis'] }, note: 'diagnose from disease KB', expectChunks: ['disease:botrytis-gray-mold'] },
  { id: 'diag-powdery', message: 'Lá dâu có lớp phấn trắng mặt dưới, mép lá cong tím, cây bị gì?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['phấn trắng'] }, note: 'diagnose from disease KB', expectChunks: ['disease:powdery-mildew'] },
  { id: 'diag-spider-mite', message: 'Lá dâu có chấm li ti vàng và có tơ nhện mảnh, xử lý thế nào?', expect: { type: 'reply' }, note: 'diagnose from disease KB', expectChunks: ['disease:spider-mite'] },
  { id: 'diag-anthracnose', message: 'Quả dâu có vết lõm nâu đen, cây con héo chết là bệnh gì?', expect: { type: 'reply' }, note: 'diagnose from disease KB', expectChunks: ['disease:anthracnose'] },
  { id: 'uses-general', message: 'Dâu tây dùng để làm gì?', expect: { type: 'reply' } },
  { id: 'uses-processing', message: 'Dâu tây chế biến được những món gì?', expect: { type: 'reply' } },

  // --- A7: facts only the reviewed source docs (data/docs) hold — measures doc retrieval ---
  { id: 'doc-nitrogen', message: 'Nồng độ đạm N trong dung dịch dinh dưỡng trồng dâu tây bao nhiêu là tốt?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['154', '182', '98'] }, expectChunks: ['https://tapchi.vaas.vn/vi/tap-chi/anh-huong-cua-nong-do-nito'] },
  { id: 'doc-leaf-spot-fungi', message: 'Bệnh đốm lá dâu tây ở Đà Lạt do những chi nấm nào gây ra?', expect: { type: 'reply' }, expectChunks: ['https://jst.iuh.edu.vn/'] },
  { id: 'doc-varieties', message: 'Giống dâu Mỹ đá và Camarosa có ưu nhược điểm gì?', expect: { type: 'reply' }, expectChunks: ['https://tapchi.vaas.vn/sites/tapchi.vaas.vn/files/tapchi/2022-03/'] },
  { id: 'doc-lowland-climate', message: 'Trồng dâu tây ở vùng thấp như Sơn La thì khí hậu ngày đêm cần thế nào?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['28', '18'] }, expectChunks: ['https://nongnghiepmoitruong.vn/'] },
  { id: 'doc-hanging-watering', message: 'Dâu tây treo thủy canh tĩnh thì mỗi ngày tưới mấy lần?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['5 lần', '7 lần'] }, expectChunks: ['https://www.sggp.org.vn/'] },
  { id: 'doc-greenhouse-yield', message: 'Trồng dâu tây New Zealand trong nhà màng năng suất được bao nhiêu tấn một héc-ta?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['30', '32'] }, expectChunks: ['https://vaas.vn/'] },
  { id: 'doc-container-temp', message: 'Trồng dâu thủy canh trong container thì giữ nhiệt độ bao nhiêu?', expect: { type: 'reply' }, expectChunks: ['https://techport.vn/'] },
]

/**
 * Bean-sprout set, picked when DEFAULT_PLANT=bean-sprout. Sprouts grow in the
 * dark, so the knowledge cases check the model does not carry strawberry advice
 * (light, soil moisture) over.
 */
export const BEAN_SPROUT_EVAL_CASES: EvalCase[] = [
  { id: 'bs-sensor', message: 'Nhiệt độ khay ủ giá của esp32-01 bây giờ bao nhiêu?', expect: { type: 'tool', tool: 'get_latest_sensor', safety: 'read' } },
  { id: 'bs-list-devices', message: 'Liệt kê các thiết bị đang có.', expect: { type: 'tool', tool: 'list_devices', safety: 'read' } },
  { id: 'bs-water', message: 'Tưới khay giá esp32-01 trong 30 giây.', expect: { type: 'tool', tool: 'set_pump', safety: 'control' } },
  { id: 'bs-auto-water', message: 'Bật chế độ tưới tự động cho esp32-01.', expect: { type: 'tool', tool: 'set_mode', safety: 'control' } },
  { id: 'bs-hello', message: 'Xin chào!', expect: { type: 'reply' } },
  { id: 'bs-kb-temp', message: 'Ủ giá đỗ cần nhiệt độ bao nhiêu?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['27', '30'] }, expectChunks: ['bean-sprout:care_notes'] },
  { id: 'bs-kb-light', message: 'Giá đỗ có cần chiếu đèn hay phơi nắng không?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['tối'] }, expectChunks: ['bean-sprout:light_description'] },
  { id: 'bs-kb-soak', message: 'Ngâm đỗ xanh làm giá bao lâu, nước bao nhiêu độ?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['35', '4 giờ', '4 h'] }, expectChunks: ['bean-sprout:planting'] },
  { id: 'bs-kb-watering', message: 'Máy làm giá tự động nên tưới theo chu kỳ thế nào?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['30 phút'] }, expectChunks: ['bean-sprout:watering'] },
  { id: 'bs-kb-harvest', message: 'Bao lâu thì thu hoạch giá được?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['48'] }, expectChunks: ['bean-sprout:harvest'] },
  { id: 'bs-kb-banned', message: 'Nước kẹo làm giá là gì, có nguy hiểm không?', expect: { type: 'reply' }, grounding: { mustIncludeAny: ['6-BAP', '6-Benzylaminopurine', 'chất cấm'] }, expectChunks: ['bean-sprout:toxicity'] },
  { id: 'bs-kb-microbe', message: 'Vì sao giá đỗ dễ bị nhiễm vi sinh vật?', expect: { type: 'reply' }, expectChunks: ['bean-sprout:diseases'] },
]

/** The eval set for a plant; plants without their own set fall back to strawberry's. */
export function evalCasesFor(plant: string): EvalCase[] {
  return plant === 'bean-sprout' ? BEAN_SPROUT_EVAL_CASES : EVAL_CASES
}
