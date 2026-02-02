import express from 'express';
import cors from 'cors';
import { Client } from '@notionhq/client';

const app = express();
app.use(cors());
app.use(express.json());

// 1. 노션 데이터베이스 목록 조회 (온보딩 시 사용)
app.post('/api/notion/databases', async (req, res) => {
    try {
        const notion = new Client({ auth: req.body.token });
        const response = await notion.search({ 
            filter: { value: 'database', property: 'object' } 
        });
        // ID와 제목만 추출하여 반환
        res.json(response.results.map(db => ({ 
            id: db.id, 
            title: db.title[0]?.plain_text || 'Untitled' 
        })));
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// 2. 캘린더 일정 조회 (위젯 렌더링 시 사용)
app.post('/api/notion/events', async (req, res) => {
    const { token, dbId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const response = await notion.databases.query({
            database_id: dbId,
            // 최근 일정이 위로 오도록 정렬 (속성명이 'Date'인 경우 기준)
            sorts: [{ property: 'Date', direction: 'ascending' }],
        });

        const events = response.results.map(page => {
            // 노션 DB의 속성 이름이 'Date'와 'Name'이라고 가정합니다.
            const dateProp = page.properties.Date?.date;
            const titleProp = page.properties.Name?.title[0]?.plain_text;

            return {
                id: page.id,
                title: titleProp || '제목 없음',
                start: dateProp?.start,
                url: page.url // 클릭 시 이동할 페이지 주소
            };
        });
        res.json(events);
    } catch (e) {
        res.status(500).json({ error: "일정을 불러오지 못했습니다: " + e.message });
    }
});

// 3. 새로운 일정 추가 (위젯에서 직접 입력 시 사용)
app.post('/api/notion/add-event', async (req, res) => {
    const { token, dbId, title, date } = req.body;
    const notion = new Client({ auth: token });
    try {
        await notion.pages.create({
            parent: { database_id: dbId },
            properties: {
                "Name": { title: [{ text: { content: title } }] },
                "Date": { date: { start: date } }
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "일정 추가 실패: " + e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Notion Calendar Server running on port ${PORT}`));
