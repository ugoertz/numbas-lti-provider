# Generated by Django 2.2.2 on 2019-10-01 08:31

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('numbas_lti', '0047_auto_20190612_1250'),
    ]

    operations = [
        migrations.AddField(
            model_name='ltiuserdata',
            name='is_instructor',
            field=models.BooleanField(default=False),
        ),
    ]