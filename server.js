import express from 'express';
import cors from 'cors';
import { Client } from '@notionhq/client';

const app = express();
app.use(cors());
app.use(express.json());

// 헬퍼: 데이터베이스에서 제목 속성 이름 찾기
async function getTitlePropertyName(notion, dbId) {
    const database = await notion.databases.retrieve({ database_id: dbId });
    for (const [name, prop] of Object.entries(database.properties)) {
        if (prop.type === 'title') {
            return name;
        }
    }
    return 'Name'; // 기본값
}

// 헬퍼: 페이지에서 제목 가져오기
function getPageTitle(page) {
    for (const [name, prop] of Object.entries(page.properties)) {
        if (prop.type === 'title' && prop.title?.length > 0) {
            return prop.title[0].plain_text;
        }
    }
    return '제목 없음';
}

// 1. 노션 데이터베이스 목록 조회
app.post('/api/notion/databases', async (req, res) => {
    try {
        const notion = new Client({ auth: req.body.token });
        const response = await notion.search({
            filter: { value: 'database', property: 'object' }
        });
        res.json(response.results.map(db => ({
            id: db.id,
            title: db.title[0]?.plain_text || 'Untitled'
        })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. 일정 조회
app.post('/api/notion/events', async (req, res) => {
    const { token, dbId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const response = await notion.databases.query({
            database_id: dbId,
            sorts: [{ property: 'Date', direction: 'ascending' }],
        });

        const events = response.results.map(page => {
            const props = page.properties;
            const dateProp = props.Date?.date;
            const startStr = dateProp?.start || '';
            const endStr = dateProp?.end || '';

            let date = startStr.split('T')[0];
            let startTime = null;
            let endTime = null;

            if (startStr.includes('T')) {
                startTime = startStr.split('T')[1]?.substring(0, 5);
            }
            if (endStr.includes('T')) {
                endTime = endStr.split('T')[1]?.substring(0, 5);
            }

            return {
                id: page.id,
                title: getPageTitle(page),
                date: date,
                startTime: startTime,
                endTime: endTime,
                done: props.Done?.checkbox || false,
                priority: props.Priority?.checkbox || false,
                category: props.Category?.multi_select?.[0]?.name || null,
                url: page.url
            };
        });
        res.json(events);
    } catch (e) {
        res.status(500).json({ error: "일정을 불러오지 못했습니다: " + e.message });
    }
});

// 3. 일정 추가
app.post('/api/notion/add-event', async (req, res) => {
    const { token, dbId, title, date, category } = req.body;
    const notion = new Client({ auth: token });
    try {
        const titlePropName = await getTitlePropertyName(notion, dbId);

        const properties = {
            [titlePropName]: { title: [{ text: { content: title } }] },
            "Date": { date: { start: date } }
        };

        if (category) {
            properties["Category"] = { multi_select: [{ name: category }] };
        }

        await notion.pages.create({
            parent: { database_id: dbId },
            properties
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "일정 추가 실패: " + e.message });
    }
});

// 4. 카테고리 조회
app.post('/api/notion/categories', async (req, res) => {
    const { token, dbId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const database = await notion.databases.retrieve({ database_id: dbId });
        const categoryProp = database.properties.Category;

        let categories = [];
        if (categoryProp?.multi_select?.options) {
            categories = categoryProp.multi_select.options.map(opt => opt.name);
        } else if (categoryProp?.select?.options) {
            categories = categoryProp.select.options.map(opt => opt.name);
        }

        res.json({ categories });
    } catch (e) {
        res.status(500).json({ error: "카테고리 조회 실패: " + e.message });
    }
});

// 5. 일정 수정
app.post('/api/notion/update-event', async (req, res) => {
    const { token, dbId, taskId, title, date, category } = req.body;
    const notion = new Client({ auth: token });
    try {
        const properties = {};

        if (title) {
            const titlePropName = await getTitlePropertyName(notion, dbId);
            properties[titlePropName] = { title: [{ text: { content: title } }] };
        }
        if (date) {
            properties["Date"] = { date: { start: date } };
        }
        if (category) {
            properties["Category"] = { multi_select: [{ name: category }] };
        }

        await notion.pages.update({ page_id: taskId, properties });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "일정 수정 실패: " + e.message });
    }
});

// 6. 일정 삭제
app.post('/api/notion/delete-event', async (req, res) => {
    const { token, taskId } = req.body;
    const notion = new Client({ auth: token });
    try {
        await notion.pages.update({ page_id: taskId, archived: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "일정 삭제 실패: " + e.message });
    }
});

// 7. 중요 표시 토글
app.post('/api/notion/toggle-star', async (req, res) => {
    const { token, taskId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const page = await notion.pages.retrieve({ page_id: taskId });
        const currentPriority = page.properties.Priority?.checkbox || false;

        await notion.pages.update({
            page_id: taskId,
            properties: { "Priority": { checkbox: !currentPriority } }
        });
        res.json({ success: true, priority: !currentPriority });
    } catch (e) {
        res.status(500).json({ error: "중요 표시 변경 실패: " + e.message });
    }
});

// 8. 완료 표시 토글
app.post('/api/notion/complete', async (req, res) => {
    const { token, taskId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const page = await notion.pages.retrieve({ page_id: taskId });
        const currentDone = page.properties.Done?.checkbox || false;

        await notion.pages.update({
            page_id: taskId,
            properties: { "Done": { checkbox: !currentDone } }
        });
        res.json({ success: true, done: !currentDone });
    } catch (e) {
        res.status(500).json({ error: "완료 표시 변경 실패: " + e.message });
    }
});

// 9. 일정 미루기
app.post('/api/notion/postpone', async (req, res) => {
    const { token, taskId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const page = await notion.pages.retrieve({ page_id: taskId });
        const currentDate = page.properties.Date?.date?.start;

        if (!currentDate) {
            return res.status(400).json({ error: "날짜가 설정되지 않은 일정입니다." });
        }

        const date = new Date(currentDate);
        date.setDate(date.getDate() + 1);
        const newDate = date.toISOString().split('T')[0];

        const newStart = currentDate.includes('T')
            ? newDate + 'T' + currentDate.split('T')[1]
            : newDate;

        await notion.pages.update({
            page_id: taskId,
            properties: { "Date": { date: { start: newStart } } }
        });
        res.json({ success: true, newDate: newStart });
    } catch (e) {
        res.status(500).json({ error: "일정 미루기 실패: " + e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Notion Calendar Server running on port ${PORT}`));
