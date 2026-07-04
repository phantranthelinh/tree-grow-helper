/**
 * Allowlist of trusted pages to scrape into the databank. This is deliberately
 * empty — add only sources YOU trust (nông nghiệp/khuyến nông, .edu.vn, .gov.vn,
 * viện nghiên cứu). Everything scraped lands in staging for review before ingest,
 * so this list is the first quality gate.
 *
 * `selector` targets the main content region of that specific site (inspect the
 * page and pick the article/main wrapper) so we skip menus, ads and comments.
 */
export interface Source {
  url: string
  category: 'grow' | 'uses' | 'disease'
  /** CSS selector for the main content region; omit to fall back to <body>. */
  selector?: string
}

/**
 * Luồng vận hành (có cổng người duyệt — KHÔNG tự động vào store):
 *   1. `npm run scrape` → ghi TẤT CẢ vào data/staging/strawberry-docs.raw.jsonl
 *      (chỉ fetch các host trong danh sách này; host lạ bị chặn cứng).
 *   2. NGƯỜI đọc, cắt bỏ boilerplate, kiểm tra là tiếng Việt + đáng tin, rồi COPY
 *      các record tốt sang data/docs/*.jsonl (tự tạo thư mục khi copy).
 *   3. Lần init sau, ingestDocs sẽ chunk → embed → khử trùng lặp → nạp vào store.
 *
 * `selector` để trống ⇒ lấy cả <body> (nhiều rác hơn — người duyệt cắt ở bước 2).
 * Nên MỞ từng trang, tìm vùng nội dung chính (article/main/.item-page…) và điền
 * `selector` để scrape sạch hơn. Các URL dưới đây là nguồn chính thống VN đã dùng
 * để soạn profile dâu (src/domain/knowledge/strawberry.json → sources).
 */
export const SOURCES: Source[] = [
  { url: 'https://khuyennong.lamdong.gov.vn/ky-thuat-trong-trot/ki-thuat-trong-rau/865-quy-trinh-k-thut-trng-cay-dau-tay', category: 'grow' },
  { url: 'https://khuyennongvn.gov.vn/hoat-dong-khuyen-nong/chuyen-giao-tbkt/lam-dong-chuyen-doi-trong-dau-tay-giup-cai-thien-sinh-ke-cho-dong-bao-dan-toc-thieu-so-31818.html', category: 'grow' },
  { url: 'https://smartfarm.mard.gov.vn/2022/12/tai-lieu-ky-thuat-canh-tac-dau-tay-ca.html', category: 'grow' },
  { url: 'https://sti.vista.gov.vn/projects/kqnv/chuyen-giao-quy-trinh-ky-thuat-san-xuat-dau-tay-ot-ngot-va-ca-chua-theo-mo-hinh-trang-trai-thong-minh-cua-han-quoc-166065.html', category: 'grow' },
  { url: 'https://techport.vn/83/quy-trinh-trong-cay-dau-tay-trong-dieu-kien-co-kiem-soat-mot-so-yeu-to-moi-truong-102381.html', category: 'grow' },
  { url: 'https://tapchi.vaas.vn/vi/tap-chi/anh-huong-cua-nong-do-nito-trong-dung-dich-dinh-duong-den-sinh-truong-nang-suat-va-chat', category: 'grow' },
  { url: 'https://tapchi.vaas.vn/vi/tap-chi/ket-qua-lai-tao-chon-loc-mot-so-dong-dau-tay-co-trien-vong-tai-lam-dong', category: 'grow' },
  { url: 'https://vaas.vn/vi/khoa-hoc-cong-nghe/ung-dung-cong-nghe-cao-trong-san-xuat-dau-tay-dam-bao-toan-thuc-pham', category: 'uses' },
  { url: 'https://jst.iuh.edu.vn/index.php/jst-iuh/article/download/5073/843/16744', category: 'disease' },
  { url: 'http://ttbvtv.lamdong.gov.vn/du-tinh-du-bao-dich-hai/sau-benh-hai-quan-tam-trong-ky/484-benh-thoi-trai-dau-tay-tai-da-lat-va-bien-phap-phong-tru', category: 'disease' },
]

/** Hosts derived from SOURCES — used to hard-block accidental off-allowlist fetches. */
export function allowedHosts(): Set<string> {
  const hosts = new Set<string>()
  for (const s of SOURCES) {
    try {
      hosts.add(new URL(s.url).host)
    } catch {
      // ignore malformed entries; they are skipped at scrape time too
    }
  }
  return hosts
}
