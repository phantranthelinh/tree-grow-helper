/**
 * Allowlist of trusted pages to scrape into the databank. Add only sources YOU
 * trust (nông nghiệp/khuyến nông, .edu.vn, .gov.vn, viện nghiên cứu). Everything
 * scraped lands in staging for review before ingest, so this list is the first
 * quality gate.
 */
export interface Source {
  url: string
  /** Profile id the record belongs to (src/domain/knowledge/<plant>.json). */
  plant: string
  category: 'grow' | 'uses' | 'disease' | 'safety'
  /**
   * Marks a PDF source: the file name it is stored under in data/pdf/<plant>/.
   * Names must be unique across plants (the converter keys output by base name).
   */
  pdf?: string
  /** CSS selector for the main content region; only the cheerio fallback uses it. */
  selector?: string
}

/**
 * Luồng vận hành (có cổng người duyệt — KHÔNG tự động vào store):
 *   1. `npm run scrape [plant]` → trang HTML qua Crawl4AI (fallback cheerio nếu
 *      Crawl4AI không chạy); PDF tải về data/pdf/<plant>/ (commit vào repo) rồi
 *      đọc bằng opendataloader-pdf. Ghi TẤT CẢ vào data/staging/<plant>-docs.raw.jsonl.
 *      Chỉ fetch các host trong danh sách này; host lạ bị chặn cứng.
 *   2. NGƯỜI đọc, cắt bỏ rác, kiểm tra là tiếng Việt + đáng tin, rồi COPY các
 *      record tốt sang data/docs/*.jsonl.
 *   3. Lần init sau (hoặc POST /api/setup/rag/rebuild), ingestDocs nạp các record
 *      có `plant` trùng DEFAULT_PLANT.
 */
export const SOURCES: Source[] = [
  // --- Dâu tây: HTML ---
  { plant: 'strawberry', category: 'grow', url: 'https://khuyennongvn.gov.vn/hoat-dong-khuyen-nong/chuyen-giao-tbkt/lam-dong-chuyen-doi-trong-dau-tay-giup-cai-thien-sinh-ke-cho-dong-bao-dan-toc-thieu-so-31818.html' },
  { plant: 'strawberry', category: 'grow', url: 'https://smartfarm.mard.gov.vn/2022/12/tai-lieu-ky-thuat-canh-tac-dau-tay-ca.html' },
  { plant: 'strawberry', category: 'grow', url: 'https://techport.vn/83/quy-trinh-trong-cay-dau-tay-trong-dieu-kien-co-kiem-soat-mot-so-yeu-to-moi-truong-102381.html' },
  { plant: 'strawberry', category: 'grow', url: 'https://tapchi.vaas.vn/vi/tap-chi/anh-huong-cua-nong-do-nito-trong-dung-dich-dinh-duong-den-sinh-truong-nang-suat-va-chat' },
  { plant: 'strawberry', category: 'grow', url: 'https://tapchi.vaas.vn/vi/tap-chi/ket-qua-lai-tao-chon-loc-mot-so-dong-dau-tay-co-trien-vong-tai-lam-dong' },
  { plant: 'strawberry', category: 'grow', url: 'https://ngheandost.gov.vn/nong-nghiep/quy-trinh-ky-thuat-trong-va-cham-soc-dau-tay-2490.html' },
  { plant: 'strawberry', category: 'grow', url: 'https://nongnghiepmoitruong.vn/ap-dung-ky-thuat-tien-tien-trong-dau-tay-lai-nua-ty-ha-d404800.html' },
  { plant: 'strawberry', category: 'grow', url: 'https://www.sggp.org.vn/nong-dan-da-lat-lam-giau-nho-trong-dau-tay-treo-post443330.html' },
  { plant: 'strawberry', category: 'uses', url: 'https://vaas.vn/vi/khoa-hoc-cong-nghe/ung-dung-cong-nghe-cao-trong-san-xuat-dau-tay-dam-bao-toan-thuc-pham' },

  // --- Dâu tây: PDF ---
  { plant: 'strawberry', category: 'disease', pdf: 'iuh-benh-dom-la-dau-tay.pdf', url: 'https://jst.iuh.edu.vn/index.php/jst-iuh/article/download/5073/843/16744' },
  { plant: 'strawberry', category: 'grow', pdf: 'vaas-2021-lai-tao-dau-tay.pdf', url: 'https://tapchi.vaas.vn/sites/tapchi.vaas.vn/files/tapchi/2022-03/tc2%20-2021.pdf' },

  // --- Giá đỗ: PDF ---
  { plant: 'bean-sprout', category: 'grow', pdf: 'vaas-2019-may-lam-gia.pdf', url: 'https://tapchi.vaas.vn/sites/tapchi.vaas.vn/files/tapchi/2021-05/TC%20so%207-2019-08.pdf' },
  { plant: 'bean-sprout', category: 'grow', pdf: 'ctu-2016-he-thong-lam-gia-sach.pdf', url: 'https://ctujsvn.ctu.edu.vn/index.php/ctujsvn/article/download/2390/1429/1429' },
  { plant: 'bean-sprout', category: 'safety', pdf: 'ninhbinh-attp-gia-do.pdf', url: 'https://s3-cdn.ninhbinh.gov.vn/nbportalcdn/tenant-binhluc1/tenant-binhluc1/van-ban/bituyntruynattp.pdf' },
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
